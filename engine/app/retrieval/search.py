"""ML-10 hierarchical retriever on Redis (Query Engine).

    nodes = load_queue_nodes(r)                       # once at boot
    res = retrieve(r, qvec, nodes, queue_probs, k=5)  # per ticket

Flow (README "Retrieval flow per ticket"):
 1. global top-10 (classifier votes + fallback)           2. queue routing score = a*p_clf + (1-a)*cos(centroid)
 3. keep top-2 queues, or only top-1 if score >= confident 4. level-2 KNN filtered to the routed queues (k=5)
 5. fallback to the global results if routed top-1 < min_top1_similarity or > margin under global top-1
 6. queried_count: HINCRBY on returned chunks (+ their queue nodes), pipelined, only when count=True.

Redis returns cosine DISTANCE; similarity = 1 - dist. Only precedent=1 chunks are ever returned.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

import numpy as np
import redis
from redis.commands.search.query import Query

from engine.app.retrieval import schema as S

_TAG_SPECIAL = re.compile(r"([,.<>{}\[\]\"':;!@#$%^&*()\-+=~/\\|? ])")
RETURN = ["ticket_id", "queue", "type", "priority", "subject", "body", "tags", "language", "answer",
          "queried_count", "dist"]


def _s(v) -> str:
    return v.decode() if isinstance(v, (bytes, bytearray)) else str(v)


def connect(url: str | None = None) -> redis.Redis:
    """Bytes-mode client (vectors are raw float32); REDIS_URL=redis://:<password>@host:6379."""
    return redis.Redis.from_url(url or os.getenv("REDIS_URL", "redis://localhost:6379"), decode_responses=False)


def tag_escape(value: str) -> str:
    """Escape a value for use inside a TAG filter: 'Technical Support' -> 'Technical\\ Support'."""
    return _TAG_SPECIAL.sub(r"\\\1", value)


@dataclass
class QueueNode:
    queue: str
    chunk_count: int
    centroid: np.ndarray


@dataclass
class Hit:
    ticket_id: str
    score: float            # cosine similarity (1 - dist)
    queue: str
    fields: dict


@dataclass
class Retrieval:
    hits: list[Hit]
    global_hits: list[Hit]
    routed_queues: list[str]
    route_scores: dict[str, float]
    fallback_global: bool
    top1: float = 0.0


def load_queue_nodes(r: redis.Redis) -> list[QueueNode]:
    nodes = []
    for key in r.scan_iter(f"{S.QUEUE_PREFIX}*"):
        h = r.hgetall(key)
        queue = h[b"queue"].decode()
        if queue == S.MISC:   # German topic rows: never a routing target
            continue
        nodes.append(QueueNode(queue, int(h[b"chunk_count"]), S.from_bytes(h[b"vector_embedding"])))
    return sorted(nodes, key=lambda n: n.queue)


def _knn(r: redis.Redis, qvec, k: int, queues: list[str] | None, index: str = S.CHUNK_INDEX) -> list[Hit]:
    flt = "@precedent:{1}"
    if queues:
        flt += " @queue:{" + "|".join(tag_escape(q) for q in queues) + "}"
    q = (Query(f"({flt})=>[KNN {k} @{S.VEC} $q AS dist]").sort_by("dist").return_fields(*RETURN)
         .paging(0, k).dialect(2))
    docs = r.ft(index).search(q, query_params={"q": S.to_bytes(qvec)}).docs
    out = []
    for d in docs:
        f = {x: _s(getattr(d, x, "")) for x in RETURN}
        out.append(Hit(f["ticket_id"], 1.0 - float(f["dist"]), f["queue"], f))
    return out


def route(qvec, nodes: list[QueueNode], queue_probs: dict[str, float] | None, alpha: float = 0.6,
          top_n: int = 2, confident: float = 0.80) -> tuple[list[str], dict[str, float]]:
    qv = np.asarray(qvec, dtype=np.float32)
    scores = {n.queue: alpha * (queue_probs or {}).get(n.queue, 0.0) + (1 - alpha) * float(n.centroid @ qv)
              for n in nodes}
    ranked = sorted(scores, key=scores.get, reverse=True)
    keep = ranked[:1] if ranked and scores[ranked[0]] >= confident else ranked[:top_n]
    return keep, scores


def retrieve(r: redis.Redis, qvec, nodes: list[QueueNode], queue_probs: dict[str, float] | None = None,
             k: int = 5, global_k: int = 10, alpha: float = 0.6, top_n: int = 2, confident: float = 0.80,
             min_top1_similarity: float = 0.0, margin: float = 0.05, count: bool = False) -> Retrieval:
    glob = _knn(r, qvec, global_k, None)
    routed, scores = route(qvec, nodes, queue_probs, alpha, top_n, confident)
    hits = _knn(r, qvec, k, routed) if routed else []
    g1 = glob[0].score if glob else 0.0
    fallback = (not hits) or hits[0].score < min_top1_similarity or hits[0].score < g1 - margin
    final = glob[:k] if fallback else hits
    res = Retrieval(final, glob, routed, scores, fallback, final[0].score if final else 0.0)
    if count and final:
        record_queries(r, final)
    return res


def record_queries(r: redis.Redis, hits: list[Hit]) -> None:
    """Atomic +1 queried_count on each returned chunk and once per distinct queue node (pipelined)."""
    pipe = r.pipeline(transaction=False)
    for h in hits:
        pipe.hincrby(S.chunk_key(h.ticket_id), "queried_count", 1)
    for q in {h.queue for h in hits}:
        pipe.hincrby(S.queue_key(q), "queried_count", 1)
    pipe.execute()


def top_queried(r: redis.Redis, n: int = 10, index: str = S.CHUNK_INDEX) -> list[dict]:
    """Most-queried chunks (analytics / burst helper; H-17 endpoint)."""
    q = Query("@queried_count:[1 +inf]").sort_by("queried_count", asc=False).paging(0, n).dialect(2)
    return [{k: _s(getattr(d, k, "")) for k in ("ticket_id", "queue", "type", "subject", "queried_count")}
            for d in r.ft(index).search(q).docs]
