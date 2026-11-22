"""Shared constants for ml/ and engine/app/analyze/. No secrets here."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.getenv("ARTIFACTS_DIR", ROOT / "ml" / "artifacts"))  # gitignored; mirrors R2 layout
RAW_DIR = ARTIFACTS / "raw"
SPLIT_DIR = ARTIFACTS / "splits" / "v1"
EMB_DIR = ARTIFACTS / "embeddings" / "v1"
MODEL_DIR = ARTIFACTS / "models" / "v1"
REPORT_DIR = ARTIFACTS / "reports" / "v1"
REDIS_DIR = ARTIFACTS / "redis"

HF_REPO = "Tobi-Bueck/customer-support-tickets"
HF_REVISION = "ddf1c81a5475992c4fa6752bf1e8b4e31f07bbeb"
PRIMARY_FILE = "aa_dataset-tickets-multi-lang-5-2-50-version.csv"   # 28,587 rows, has answers
EXTRA_FILE = "dataset-tickets-multi-lang-4-20k.csv"                 # overlaps primary; extra unique rows
GERMAN_FILE = "dataset-tickets-german_normalized_50_5_2.csv"        # no answer/type/tags -> Miscellaneous branch only

SEED = 42
KB_FRAC = 0.8
KB_VAL_FRAC = 0.1  # last 10% of the KB, used for tuning/calibration only

TARGETS = ["type", "queue", "priority"]
# Some copies carry 5 priority levels (e.g. critical/very_low). Collapse to high/medium/low.
PRIORITY_MAP = {
    "critical": "high", "very_high": "high", "very high": "high", "high": "high",
    "medium": "medium", "normal": "medium",
    "low": "low", "very_low": "low", "very low": "low",
}

EMBED_MODEL = os.getenv("EMBED_MODEL", "gemini-embedding-2")
EMBED_DIM = int(os.getenv("EMBED_DIM", "768"))
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
