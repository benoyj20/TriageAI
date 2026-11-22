"""
DA-01 & DA-02 & DA-09: Exploratory Data Analysis & Insights Export
Processes the Customer Support Tickets dataset and exports structured JSON telemetry
for the Frontend Insights tab and Executive Performance Reports.
"""

import os
import json
from datetime import datetime, timezone

import pandas as pd
import numpy as np

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LOCAL_DATA_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "data"))
INSIGHTS_DIR = os.path.join(BASE_DIR, "analytics", "insights")
FRONTEND_INSIGHTS_DIR = os.path.join(BASE_DIR, "frontend", "src", "features", "insights", "data")

os.makedirs(INSIGHTS_DIR, exist_ok=True)
os.makedirs(FRONTEND_INSIGHTS_DIR, exist_ok=True)

FULL_CSV = "aa_dataset-tickets-multi-lang-5-2-50-version.csv"
SUBSET_CSV = "dataset-tickets-multi-lang-4-20k.csv"
HF_DATASET = "Tobi-Bueck/customer-support-tickets"


def normalize_priority(series: pd.Series) -> pd.Series:
    """Map 1/2/3 or text variants to high | medium | low (hackathon brief)."""
    mapping = {
        "1": "low",
        "2": "medium",
        "3": "high",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "critical": "high",
    }
    return (
        series.astype(str)
        .str.strip()
        .str.lower()
        .map(lambda v: mapping.get(v, v))
    )


def resolve_dataset_path() -> tuple[str, str]:
    """Prefer full HF CSV, then 20k subset, then kb_train split."""
    csv_candidates = [
        (os.path.join(LOCAL_DATA_DIR, FULL_CSV), f"{HF_DATASET} (full EN/DE)"),
        (os.path.join(LOCAL_DATA_DIR, SUBSET_CSV), f"{HF_DATASET} (20k subset)"),
        (os.path.join(LOCAL_DATA_DIR, "kb_train.csv"), f"{HF_DATASET} (kb_train split)"),
    ]
    for path, label in csv_candidates:
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path, label
    tried = "\n".join(f"  - {p}" for p, _ in csv_candidates)
    raise FileNotFoundError(f"Could not locate dataset in {LOCAL_DATA_DIR}. Tried:\n{tried}")


def run_eda_and_export():
    data_path, dataset_label = resolve_dataset_path()

    print(f"Loading dataset from: {data_path}")
    df = pd.read_csv(data_path)
    print(f"Total rows: {len(df):,}")

    if "priority" in df.columns:
        df["priority"] = normalize_priority(df["priority"])

    df["subject"] = df["subject"].fillna("")
    df["body"] = df["body"].fillna("")
    df["subject_len"] = df["subject"].str.len()
    df["body_len"] = df["body"].str.len()
    if "answer" in df.columns:
        df["answer_len"] = df["answer"].fillna("").str.len()
    else:
        df["answer_len"] = 0

    # 1. Operational Insights (DA-02)
    # Insights UI expects en + de keys (InsightsTab.jsx KPI strip).
    lang_counts = {k: int(v) for k, v in df["language"].value_counts().to_dict().items()}
    for code in ("en", "de"):
        lang_counts.setdefault(code, 0)
    lang_pcts = (df["language"].value_counts(normalize=True) * 100).round(1).to_dict()
    for code in ("en", "de"):
        lang_pcts.setdefault(code, 0.0)

    queue_counts = df["queue"].value_counts().to_dict()
    priority_counts = df["priority"].value_counts().to_dict()
    type_counts = df["type"].value_counts().to_dict()

    # Outage concentration by queue (Incident & High)
    outages = df[(df["type"] == "Incident") & (df["priority"] == "high")]
    outages_by_queue = outages["queue"].value_counts().to_dict()

    operations_insights = {
        "dataset_name": dataset_label,
        "source_file": os.path.basename(data_path),
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "verify_command": "python3 analytics/verify_operations_insights.py",
        "total_volume": len(df),
        "languages": {
            "counts": lang_counts,
            "percentages": lang_pcts
        },
        "queues": queue_counts,
        "priorities": priority_counts,
        "types": type_counts,
        "critical_outages": {
            "total_count": len(outages),
            "percentage": round(len(outages) / len(df) * 100, 2),
            "by_queue": outages_by_queue
        },
        "text_telemetry": {
            "avg_subject_chars": round(float(df["subject_len"].mean()), 1),
            "avg_body_chars": round(float(df["body_len"].mean()), 1),
            "avg_answer_chars": round(float(df["answer_len"].mean()), 1),
            "null_subject_pct": round(float((df["subject_len"] == 0).mean() * 100), 2)
        }
    }

    # Model metrics (model_insights.json) come from the holdout evaluation, not from EDA:
    # python -m ml.evaluate, then python analytics/export_model_insights.py.

    # Export to analytics and frontend directories
    for target_dir in [INSIGHTS_DIR, FRONTEND_INSIGHTS_DIR]:
        op_path = os.path.join(target_dir, "operations_insights.json")
        with open(op_path, "w", encoding="utf-8") as f:
            json.dump(operations_insights, f, indent=2, ensure_ascii=False)
        print(f"Exported insights to: {target_dir}")

if __name__ == "__main__":
    run_eda_and_export()
