"""
DA-02 verification: operations_insights.json schema, mirror sync, and CSV cross-check.

Run from gdg-sentinal root:
  python3 analytics/verify_operations_insights.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pandas as pd

from eda_pipeline import (
    FRONTEND_INSIGHTS_DIR,
    INSIGHTS_DIR,
    LOCAL_DATA_DIR,
    normalize_priority,
)

ANALYTICS_JSON = Path(INSIGHTS_DIR) / "operations_insights.json"
FRONTEND_JSON = Path(FRONTEND_INSIGHTS_DIR) / "operations_insights.json"

# Keys read by frontend/src/features/insights/InsightsTab.jsx (operations sub-tab).
REQUIRED_PATHS: list[tuple[str, type | tuple[type, ...]]] = [
    ("total_volume", int),
    ("languages", dict),
    ("languages.counts", dict),
    ("languages.counts.en", int),
    ("languages.counts.de", int),
    ("languages.percentages", dict),
    ("languages.percentages.en", (int, float)),
    ("languages.percentages.de", (int, float)),
    ("queues", dict),
    ("priorities", dict),
    ("critical_outages", dict),
    ("critical_outages.total_count", int),
    ("critical_outages.percentage", (int, float)),
    ("text_telemetry", dict),
    ("text_telemetry.avg_body_chars", (int, float)),
    ("text_telemetry.null_subject_pct", (int, float)),
]


def _get_nested(data: dict[str, Any], dotted: str) -> Any:
    node: Any = data
    for key in dotted.split("."):
        if not isinstance(node, dict) or key not in node:
            raise KeyError(dotted)
        node = node[key]
    return node


def check_schema(ops: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for path, expected_types in REQUIRED_PATHS:
        try:
            value = _get_nested(ops, path)
        except KeyError:
            errors.append(f"missing key: {path}")
            continue
        if not isinstance(value, expected_types):
            errors.append(f"{path}: expected {expected_types}, got {type(value).__name__}")
    if ops.get("queues") == {}:
        errors.append("queues: must not be empty")
    return errors


def check_mirrors() -> list[str]:
    errors: list[str] = []
    if not ANALYTICS_JSON.is_file():
        errors.append(f"missing: {ANALYTICS_JSON}")
    if not FRONTEND_JSON.is_file():
        errors.append(f"missing: {FRONTEND_JSON}")
    if errors:
        return errors
    a = json.loads(ANALYTICS_JSON.read_text(encoding="utf-8"))
    b = json.loads(FRONTEND_JSON.read_text(encoding="utf-8"))
    if a != b:
        errors.append(
            "analytics and frontend JSON differ — run: python3 analytics/eda_pipeline.py"
        )
    return errors


def expected_from_csv(csv_path: Path) -> dict[str, Any]:
    df = pd.read_csv(csv_path)
    if "priority" in df.columns:
        df["priority"] = normalize_priority(df["priority"])
    df["subject"] = df["subject"].fillna("")
    df["body"] = df["body"].fillna("")

    lang_counts = {k: int(v) for k, v in df["language"].value_counts().to_dict().items()}
    for code in ("en", "de"):
        lang_counts.setdefault(code, 0)
    lang_pcts = (df["language"].value_counts(normalize=True) * 100).round(1).to_dict()
    for code in ("en", "de"):
        lang_pcts.setdefault(code, 0.0)

    outages = df[(df["type"] == "Incident") & (df["priority"] == "high")]
    subject_len = df["subject"].str.len()
    null_subject_pct = round(float((subject_len == 0).mean() * 100), 2)

    return {
        "total_volume": len(df),
        "languages": {"counts": lang_counts, "percentages": lang_pcts},
        "critical_outages": {
            "total_count": len(outages),
            "percentage": round(len(outages) / len(df) * 100, 2),
        },
        "text_telemetry": {
            "avg_body_chars": round(float(df["body"].str.len().mean()), 1),
            "null_subject_pct": null_subject_pct,
        },
    }


def check_csv_alignment(ops: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    source = ops.get("source_file")
    if not source:
        errors.append("source_file missing — re-export with eda_pipeline.py")
        return errors

    # ../data (EDA convention) first, then where `python -m ml.split` downloads the dataset.
    candidates = [Path(LOCAL_DATA_DIR) / source, Path(__file__).resolve().parents[1] / "ml" / "artifacts" / "raw" / source]
    csv_path = next((c for c in candidates if c.is_file()), None)
    if csv_path is None:
        errors.append("CSV not found for source_file in: " + ", ".join(str(c) for c in candidates))
        return errors

    exp = expected_from_csv(csv_path)
    checks = [
        ("total_volume", ops["total_volume"], exp["total_volume"]),
        ("languages.counts.de", ops["languages"]["counts"]["de"], exp["languages"]["counts"]["de"]),
        ("languages.percentages.de", ops["languages"]["percentages"]["de"], exp["languages"]["percentages"]["de"]),
        ("critical_outages.total_count", ops["critical_outages"]["total_count"], exp["critical_outages"]["total_count"]),
        ("critical_outages.percentage", ops["critical_outages"]["percentage"], exp["critical_outages"]["percentage"]),
        ("text_telemetry.avg_body_chars", ops["text_telemetry"]["avg_body_chars"], exp["text_telemetry"]["avg_body_chars"]),
        ("text_telemetry.null_subject_pct", ops["text_telemetry"]["null_subject_pct"], exp["text_telemetry"]["null_subject_pct"]),
    ]
    for name, got, want in checks:
        if got != want:
            errors.append(f"{name}: json={got!r} csv={want!r}")
    return errors


def main() -> int:
    print("TriageAI DA-02 — verify operations_insights.json\n")

    errors = check_mirrors()
    if errors:
        for e in errors:
            print(f"  FAIL  {e}")
        return 1

    ops = json.loads(FRONTEND_JSON.read_text(encoding="utf-8"))
    print(f"  OK    both mirrors exist and match")
    print(f"        dataset: {ops.get('dataset_name')} ({ops.get('source_file')})")

    for e in check_schema(ops):
        errors.append(e)
    if errors:
        for e in errors:
            print(f"  FAIL  {e}")
        return 1
    print("  OK    InsightsTab schema")

    for e in check_csv_alignment(ops):
        errors.append(e)
    if errors:
        for e in errors:
            print(f"  FAIL  {e}")
        return 1
    print(f"  OK    CSV cross-check ({ops['total_volume']:,} rows)")

    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())