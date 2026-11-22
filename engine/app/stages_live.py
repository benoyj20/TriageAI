"""Live pipeline stages: language, embedding + Redis retrieval, classification (task H-13 wiring).

These replace the stubs in stubs.py when Redis and Gemini are configured (pipeline.use_live_stages).

* language:          ML engineer's detector (langdetect + stopword fallback).
* global_search:     embed the query once with the shared Gemini client, unfiltered top-10 from Redis.
* classify:          if a trained model bundle is on disk (ml/artifacts/models/v1 or MODEL_DIR) it is used;
                     otherwise a similarity-weighted neighbour vote over the global top-10 (real kNN, no rules).
* route_and_search:  the ML engineer's hierarchical retriever (level-1 queue routing, level-2 filtered KNN,
                     global fallback), mapped into the contract's retrieval/precedents shape.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

import numpy as np

from engine.app.common.providers import embed_texts, embedding_identity
from engine.app.retrieval import search as R
from engine.app.settings import get_settings
from engine.app.state import TicketState

log = logging.getLogger("sentineldesk.live")

TYPES = ("Incident", "Request", "Problem", "Change")
PRIORITIES = ("high", "medium", "low")

_lock = threading.Lock()
_redis: Any = None
_nodes: list[R.QueueNode] | None = None


def _conn() -> Any:
    global _redis
    with _lock:
        if _redis is None:
            _redis = R.connect(get_settings().redis_url)
        return _redis


def queue_nodes() -> list[R.QueueNode]:
    global _nodes
    with _lock:
        cached = _nodes
    if cached is None:
        cached = R.load_queue_nodes(_conn())
        with _lock:
            _nodes = cached
    return cached


def reset() -> None:
    """Forget the Redis connection and cached queue nodes (tests, or after re-indexing)."""
    global _redis, _nodes, _index_checked, _model, _model_checked
    with _lock:
        _redis, _nodes, _index_checked = None, None, False
        _model, _model_checked = None, False


# ---- language -----------------------------------------------------------------


def language_stage(state: TicketState) -> None:
    from engine.app.analyze.language import detect_language

    code, conf = detect_language(state.text)
    code = (code or "unknown").lower()[:2] if code else "unknown"
    state.language = {"code": code, "confidence": round(min(max(float(conf), 0.0), 1.0), 3), "supported": code in ("en", "de")}


# ---- embedding + global search --------------------------------------------------


_index_checked = False


def check_index_matches_embeddings() -> None:
    """Refuse to search an index built with a different embedding model: the vectors are not comparable."""
    global _index_checked
    if _index_checked:
        return
    meta = {k.decode(): v.decode() for k, v in _conn().hgetall("meta:embedding").items()}
    now = embedding_identity()
    if not meta:
        log.warning("Redis has no meta:embedding record; cannot verify the index was built with %s/%s", now["provider"], now["model"])
    elif (meta.get("provider"), meta.get("model"), meta.get("dim")) != (now["provider"], now["model"], str(now["dim"])):
        raise RuntimeError(
            f"The Redis index was built with {meta.get('provider')}/{meta.get('model')} ({meta.get('dim')}d) but the engine now "
            f"embeds with {now['provider']}/{now['model']} ({now['dim']}d). Re-embed the knowledge base or set EMBED_PROVIDER."
        )
    _index_checked = True


def global_search_stage(state: TicketState) -> None:
    from engine.app.analyze.textproc import build_text

    check_index_matches_embeddings()

    vec = np.asarray(embed_texts([build_text(state.subject, state.body)[:6000]])[0], dtype=np.float32)
    state.query_embedding = vec.tolist()
    state.global_neighbours = R._knn(_conn(), vec, 10, None)


# ---- classification ------------------------------------------------------------


def _vote(hits: list[Any], key: str, classes: list[str], power: float = 2.0) -> dict[str, float]:
    weights = {c: 0.0 for c in classes}
    for h in hits:
        label = h.fields.get(key)
        if label in weights:
            weights[label] += max(h.score, 0.0) ** power
    total = sum(weights.values())
    return {c: (w / total if total else 1.0 / len(classes)) for c, w in weights.items()}


def _head(probs: dict[str, float]) -> tuple[str, float]:
    label = max(probs, key=probs.get)
    return label, probs[label]


# ---- trained model + thresholds (ML engineer's artifacts) -----------------------

_model: Any = None
_model_checked = False


def model_dirs() -> list[Any]:
    """Where the trained bundle can live: the R2-synced cache (production) or ml/artifacts (local)."""
    from pathlib import Path

    from engine.app.analyze.classify import DEFAULT_MODEL_DIR

    return [get_settings().artifact_cache / "models", Path(DEFAULT_MODEL_DIR)]


def classifier() -> Any:
    """The trained Classifier, or None when no bundle is available (then the neighbour vote is used)."""
    global _model, _model_checked
    with _lock:
        if _model_checked:
            return _model
    found = None
    for d in model_dirs():
        if (d / "classifier.joblib").exists() and (d / "thresholds.json").exists():
            from engine.app.analyze.classify import Classifier

            found = Classifier.load(d)
            log.info("classifier loaded from %s", d)
            break
    if found is None:
        log.warning("no trained classifier found in %s; using the neighbour vote", [str(d) for d in model_dirs()])
    with _lock:
        _model, _model_checked = found, True
    return found


def thresholds() -> dict[str, Any]:
    m = classifier()
    return dict(m.th) if m is not None else {}


def apply_thresholds() -> dict[str, Any]:
    """Configure the gate from the tuned thresholds (falls back to the measured defaults)."""
    from engine.app import pipeline

    th = thresholds()
    gate_kwargs = {
        "high_priority_threshold": float(th.get("priority_high_threshold", 0.38)),
        # NO_PRECEDENT cut-off for live tickets. Measured on the full OpenAI index: off-topic top-1 <= 0.28,
        # hand-typed support tickets >= 0.37, held-out dataset tickets >= 0.59. retrieval_threshold (0.83)
        # is the ML precision metric for "useful precedent" and would flag every hand-typed ticket.
        "precedent_similarity_threshold": float(th.get("no_precedent_threshold", 0.35)),
    }
    pipeline.reset_gate(**gate_kwargs)
    # The recall-tuned incident rule (P(Incident) >= incident_threshold) reaches 0.93 holdout recall but flags
    # ~39% of tickets for on-call (e.g. invoice requests). Off by default; the argmax rule with the tuned P(high)
    # threshold gives 0.87 recall at 0.53 precision. Set "gate_incident_rule": true in thresholds.json to switch.
    use_rule = bool(th.get("gate_incident_rule", False)) and "incident_threshold" in th
    pipeline.INCIDENT_THRESHOLD = float(th["incident_threshold"]) if use_rule else None
    log.info("gate thresholds: %s, incident_threshold=%s", gate_kwargs, pipeline.INCIDENT_THRESHOLD)
    return {**gate_kwargs, "incident_threshold": pipeline.INCIDENT_THRESHOLD}


def _contract_heads(out: dict[str, Any], hits: list[Any]) -> dict[str, Any]:
    t, q, p = out["type"]["probs"], out["queue"]["probs"], out["priority"]["probs"]
    t = {c: float(t.get(c, 0.0)) for c in TYPES}
    p = {c: float(p.get(c, 0.0)) for c in PRIORITIES}
    top5 = dict(sorted(((k, float(v)) for k, v in q.items()), key=lambda kv: kv[1], reverse=True)[:5])
    t_label, t_conf = _head(t)
    q_label, q_conf = _head(top5)
    p_label, p_conf = _head(p)
    return {
        "type": {"label": t_label, "confidence": t_conf, "probs": t},
        "queue": {
            "label": q_label,
            "confidence": q_conf,
            "probs": top5,
            "votes": sum(1 for h in hits if h.fields.get("queue") == q_label),
            "k": len(hits),
        },
        "priority": {"label": p_label, "confidence": p_conf, "probs": p, "p_high": p["high"]},
    }


def classify_stage(state: TicketState) -> None:
    hits = state.global_neighbours
    model = classifier()
    if model is not None:
        from types import SimpleNamespace

        votes = [SimpleNamespace(payload=h.fields, score=h.score) for h in hits]  # vote_probs reads .payload
        state.classification = _contract_heads(model.predict(state.subject, state.body, hits=votes), hits)
        return
    queues = sorted({h.fields.get("queue", "") for h in hits if h.fields.get("queue")}) or ["General Inquiry"]
    t, q, p = _vote(hits, "type", list(TYPES)), _vote(hits, "queue", queues), _vote(hits, "priority", list(PRIORITIES))
    top5 = dict(sorted(q.items(), key=lambda kv: kv[1], reverse=True)[:5])
    t_label, t_conf = _head(t)
    q_label, q_conf = _head(top5)
    p_label, p_conf = _head(p)
    state.classification = {
        "type": {"label": t_label, "confidence": t_conf, "probs": t},
        "queue": {
            "label": q_label,
            "confidence": q_conf,
            "probs": top5,
            "votes": sum(1 for h in hits if h.fields.get("queue") == q_label),
            "k": len(hits),
        },
        "priority": {"label": p_label, "confidence": p_conf, "probs": p, "p_high": p["high"]},
    }


# ---- hierarchical retrieval -----------------------------------------------------


def _precedent(hit: R.Hit) -> dict[str, Any]:
    f = hit.fields
    snippet = " ".join(f.get("answer", "").split())[:300]
    return {
        "ticket_id": hit.ticket_id,
        "similarity": round(min(max(hit.score, -1.0), 1.0), 4),
        "language": f.get("language") or "unknown",
        "type": f.get("type") or "Request",
        "queue": hit.queue,
        "priority": f.get("priority") or "medium",
        "subject": f.get("subject", ""),
        "answer_snippet": snippet,
        "tags": [t for t in f.get("tags", "").split(",") if t],
    }


def route_and_search_stage(state: TicketState) -> None:
    if not state.query_embedding:
        raise RuntimeError("No query embedding: the global search stage failed earlier.")
    q = np.asarray(state.query_embedding, dtype=np.float32)
    queue_probs = (state.classification or {}).get("queue", {}).get("probs", {})
    th = thresholds()
    res = R.retrieve(
        _conn(), q, queue_nodes(), queue_probs, k=5, count=False,
        alpha=float(th.get("route_alpha", 0.6)),
        top_n=int(th.get("route_top_n", 2)),
        confident=float(th.get("route_confident", 0.80)),
        # Fall back to the global search on the margin rule only; an absolute cut at retrieval_threshold
        # (0.83) would bypass the queue routing for every hand-typed ticket.
        min_top1_similarity=float(th.get("route_min_top1", 0.0)),
        margin=float(th.get("fallback_margin", 0.05)),
    )
    state.precedents = [_precedent(h) for h in res.hits]
    state.evidence = {h.ticket_id: h.fields.get("answer", "") for h in res.hits}
    ranked = sorted(res.route_scores.items(), key=lambda kv: kv[1], reverse=True)[:3]
    state.retrieval = {
        "route": {
            "queues": [{"queue": name, "score": round(min(max(score, 0.0), 1.0), 4)} for name, score in ranked],
            "searched": list(res.routed_queues),
            "fallback_global": bool(res.fallback_global),
        },
        "top_similarity": state.precedents[0]["similarity"] if state.precedents else 0.0,
        "k": 5,
    }
