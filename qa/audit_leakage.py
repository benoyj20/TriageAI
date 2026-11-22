#!/usr/bin/env python3
"""Data leakage audit (QA-09), run against the split that ml/split.py actually writes.

Reads ml/artifacts/splits/v1/ (or ARTIFACTS_DIR) and checks:
1. KB and holdout ticket IDs are disjoint, and together cover every row exactly once.
2. The split is 80/20 and was made with seed 42 (from split_manifest.json).
3. test_inputs.csv (the only test file inference may read) holds exactly ticket_id, subject, body.
4. No `answer` column is saved for the holdout, in test_inputs.csv or test_labels.csv.
5. No holdout ticket body appears verbatim (after whitespace/case normalisation) in the KB.
6. File checksums match the ones recorded in split_manifest.json when the split was made.

Writes qa/LEAKAGE_AUDIT.md. Exit code 0 only when every check passes.
Run from the repo root after `python -m ml.split`:  python qa/audit_leakage.py
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.getenv("ARTIFACTS_DIR", REPO_ROOT / "ml" / "artifacts"))
SPLIT_DIR = ARTIFACTS / "splits" / "v1"
REPORT_PATH = REPO_ROOT / "qa" / "LEAKAGE_AUDIT.md"
FILES = ("kb_train.csv", "test_inputs.csv", "test_labels.csv")


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while chunk := f.read(1 << 16):
            h.update(chunk)
    return h.hexdigest()


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", str(text)).strip().lower()


def run() -> int:
    missing = [f for f in FILES + ("split_manifest.json",) if not (SPLIT_DIR / f).exists()]
    if missing:
        print(f"Split files not found in {SPLIT_DIR}: {', '.join(missing)}. Run `python -m ml.split` first.")
        return 1

    manifest = json.loads((SPLIT_DIR / "split_manifest.json").read_text())
    kb = pd.read_csv(SPLIT_DIR / "kb_train.csv", keep_default_na=False)
    inputs = pd.read_csv(SPLIT_DIR / "test_inputs.csv", keep_default_na=False)
    labels = pd.read_csv(SPLIT_DIR / "test_labels.csv", keep_default_na=False)

    checks: list[tuple[str, bool, str]] = []

    kb_ids, test_ids = set(kb["ticket_id"]), set(inputs["ticket_id"])
    overlap = kb_ids & test_ids
    checks.append(("KB and holdout ticket IDs are disjoint", not overlap, f"{len(overlap)} shared IDs"))
    covered = len(kb_ids) + len(test_ids) == manifest["rows"]["total"] and set(labels["ticket_id"]) == test_ids
    checks.append(("Every row lands in exactly one split", covered,
                   f"{len(kb_ids):,} KB + {len(test_ids):,} holdout = {manifest['rows']['total']:,} rows"))

    total = len(kb) + len(inputs)
    kb_pct, test_pct = 100 * len(kb) / total, 100 * len(inputs) / total
    ratio_ok = abs(kb_pct - 80) < 0.1 and manifest["seed"] == 42 and manifest["kb_frac"] == 0.8
    checks.append(("80/20 split with random_state=42", ratio_ok,
                   f"{kb_pct:.1f}% / {test_pct:.1f}%, seed {manifest['seed']}"))

    cols = list(inputs.columns)
    checks.append(("Inference inputs hold only ticket_id, subject, body", cols == ["ticket_id", "subject", "body"],
                   f"columns: {', '.join(cols)}"))

    answer_cols = [f for f, df in (("test_inputs.csv", inputs), ("test_labels.csv", labels)) if "answer" in df.columns]
    checks.append(("No holdout `answer` is saved anywhere", not answer_cols,
                   "none" if not answer_cols else "found in " + ", ".join(answer_cols)))

    kb_bodies = {norm(b) for b in kb["body"]}
    dup = sum(norm(b) in kb_bodies for b in inputs["body"])
    checks.append(("No holdout body appears verbatim in the KB", dup == 0, f"{dup} duplicated bodies"))

    shas = {f: sha256_file(SPLIT_DIR / f) for f in FILES}
    recorded = manifest.get("sha256", {})
    sha_ok = all(recorded.get(f) == s for f, s in shas.items())
    checks.append(("Files match the checksums recorded at split time", sha_ok,
                   "all match" if sha_ok else "mismatch: files changed after the split"))

    passed = all(ok for _, ok, _ in checks)
    for name, ok, detail in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {name}  ({detail})")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    rows = "\n".join(f"| {name} | {detail} | {'Pass' if ok else '**Fail**'} |" for name, ok, detail in checks)
    sizes = "\n".join(
        f"| `{f}` | {n:,} | {desc} | `{shas[f]}` |"
        for f, n, desc in (
            ("kb_train.csv", len(kb), "80% knowledge base: training, calibration (last 10% = kb_val) and RAG index"),
            ("test_inputs.csv", len(inputs), "20% holdout, inference inputs only"),
            ("test_labels.csv", len(labels), "20% holdout labels, read only by `ml/evaluate.py` for scoring"),
        )
    )
    src = manifest["source"]
    report = f"""# Data leakage audit (QA-09)

**Run:** {now}, by `python qa/audit_leakage.py`
**Dataset:** `{src['repo']}` at revision `{src['revision'][:12]}`, files: {', '.join(f'`{f}`' for f in src['files'])}
**Rows after de-duplicating on normalised body:** {manifest['rows']['total']:,}
**Result:** {'all checks pass' if passed else 'FAILED, see below'}

## Checks

| Check | Detail | Result |
|---|---|---|
{rows}

## Split files

| File | Rows | Use | SHA-256 |
|---|---:|---|---|
{sizes}

The split follows the brief exactly: `df.sample(frac=1.0, random_state=42)`, IDs `TKT-{{i:05d}}`, first 80% is the KB.
The German topic file (no answers) is split the same way and only its 80% is indexed, never as a citable precedent.
"""
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(f"Report written to {REPORT_PATH.relative_to(REPO_ROOT)}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(run())
