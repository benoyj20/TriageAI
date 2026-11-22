"""
DA-09: Build model_insights.json for the Reports page from the real holdout evaluation.

Reads what the ML pipeline writes (ARTIFACTS_DIR, default ml/artifacts/):
  reports/v1/metrics.json      python -m ml.evaluate      (required)
  reports/v1/latency.json      python -m ml.latency       (optional; per-stage p50)
  models/v1/thresholds.json    python -m ml.train         (gate thresholds the engine loads)
  splits/v1/split_manifest.json python -m ml.split        (KB and holdout sizes)

Writes analytics/insights/model_insights.json and the frontend mirror. Run from the repo root:
  python analytics/export_model_insights.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
ARTIFACTS = Path(os.getenv("ARTIFACTS_DIR", BASE_DIR / "ml" / "artifacts"))
METRICS = ARTIFACTS / "reports" / "v1" / "metrics.json"
LATENCY = ARTIFACTS / "reports" / "v1" / "latency.json"
THRESHOLDS = ARTIFACTS / "models" / "v1" / "thresholds.json"
MANIFEST = ARTIFACTS / "splits" / "v1" / "split_manifest.json"
INSIGHTS_DIR = BASE_DIR / "analytics" / "insights"
FRONTEND_INSIGHTS_DIR = BASE_DIR / "frontend" / "src" / "features" / "insights" / "data"

ARCHITECTURE = {
    "classifier": "TF-IDF (word + char n-grams) + logistic regression per head, temperature-calibrated on kb_val",
    "embeddings": "OpenAI text-embedding-3-small, 768 dims (Gemini gemini-embedding-2 if no OpenAI key)",
    "vector_store": "Redis Query Engine, HNSW cosine; hierarchical: queue routing, then KNN inside the routed queues",
    "llm_draft_model": "OpenAI gpt-5.4-mini, then Gemini, then extractive fallback; every draft validated",
}
P1 = ["HIGH_PRIORITY_INCIDENT", "SECURITY_INCIDENT", "ACTIVE_OUTAGE"]
P2 = ["LEGAL_OR_COMPLIANCE", "PROMPT_INJECTION", "NO_PRECEDENT", "LOW_CONFIDENCE",
      "UNSUPPORTED_REQUEST", "UNGROUNDED_DRAFT", "UNSUPPORTED_LANGUAGE", "ENGINE_DEGRADED"]


def _read(path: Path) -> dict | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def _p50(lat: dict | None, key: str) -> float | None:
    v = (lat or {}).get(key)
    return v.get("p50_ms") if isinstance(v, dict) else None


def build(metrics: dict, latency: dict | None, th: dict, manifest: dict | None) -> dict:
    t = metrics["targets"]
    m = {}
    for head in ("type", "queue", "priority"):
        m[f"{head}_macro_f1"] = round(t[head]["macro_f1"], 4)
        m[f"{head}_weighted_f1"] = round(t[head]["per_class"]["weighted avg"]["f1-score"], 4)
        m[f"{head}_accuracy"] = round(t[head]["accuracy"], 4)
        m[f"{head}_ece"] = round(t[head]["ece"], 4)

    # Report the recall of the rule the engine's gate actually uses (stages_live.apply_thresholds):
    # P(Incident) >= incident_threshold only when gate_incident_rule is on, otherwise argmax type == Incident.
    incident_rule = bool(th.get("gate_incident_rule", False)) and "incident_threshold" in th
    gate_hpi = metrics["high_priority_incident"] if incident_rule else metrics["high_priority_incident_argmax_rule"]
    other = metrics["high_priority_incident_argmax_rule"] if incident_rule else metrics["high_priority_incident"]
    m.update({
        "high_priority_incident_recall": round(gate_hpi["recall"], 4),
        "high_priority_incident_precision": round(gate_hpi["precision"], 4),
        "high_priority_incident_flag_rate": round(gate_hpi["flag_rate"], 4),
        "high_priority_incident_support": gate_hpi["support"],
        "high_priority_incident_rule": "p_incident" if incident_rule else "argmax_type",
        "alternative_rule_recall": round(other["recall"], 4),
        "alternative_rule_precision": round(other["precision"], 4),
    })

    classify = _p50(latency, "classify")
    language = _p50(latency, "language")
    retrieve = _p50(latency, "retrieve")
    return {
        "metrics_source": "holdout_eval",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reproduce": "python -m ml.split && python -m ml.train && python -m ml.evaluate && python -m ml.latency",
        "architecture": ARCHITECTURE,
        "holdout_benchmark": {
            "eval_sample_size": metrics["n_test"],
            "kb_size": (manifest or {}).get("rows", {}).get("kb"),
            "blend_weight": metrics.get("blend_weight", 0.0),
            "metrics": m,
            "latency": {
                # Offline p50 on one machine. Retrieval and drafting need the live stack (Redis, LLM);
                # null means not measured here, and the console shows live per-stage times instead.
                "language_ms": language,
                "triage_inference_per_ticket_ms": classify,
                "precedent_retrieval_ms": retrieve,
                "grounded_synthesis_ms": None,
                "total_e2e_latency_ms": None,
            },
        },
        "safety_gate_policy": {
            # Same defaults as engine/app/stages_live.apply_thresholds and policy/gate.py.
            "high_priority_threshold": float(th.get("priority_high_threshold", 0.38)),
            "incident_threshold": float(th["incident_threshold"]) if incident_rule else None,
            "confidence_floor": 0.42,
            "precedent_similarity_threshold": float(th.get("no_precedent_threshold", 0.35)),
            "p1_codes": P1,
            "p2_codes": P2,
        },
    }


def write_mirrors(model: dict) -> None:
    for target in (INSIGHTS_DIR, FRONTEND_INSIGHTS_DIR):
        target.mkdir(parents=True, exist_ok=True)
        path = target / "model_insights.json"
        path.write_text(json.dumps(model, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Wrote {path.relative_to(BASE_DIR)}")


def main() -> int:
    metrics = _read(METRICS)
    if metrics is None:
        print(f"Missing {METRICS}. Run: python -m ml.split && python -m ml.train && python -m ml.evaluate")
        return 1
    model = build(metrics, _read(LATENCY), _read(THRESHOLDS) or {}, _read(MANIFEST))
    write_mirrors(model)
    return 0


if __name__ == "__main__":
    sys.exit(main())
