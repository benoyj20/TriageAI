"""ML-03: lock the 80/20 split exactly as the brief specifies.

    df.sample(frac=1.0, random_state=42).reset_index(drop=True); ids TKT-{i:05d}; first 80% = KB.

Outputs (ml/artifacts/splits/v1/):
  kb_train.csv      KB rows with labels + answer; column `is_val` marks the last 10% of the KB
  test_inputs.csv   ticket_id, subject, body only  (what inference may see)
  test_labels.csv   ticket_id + labels; read ONLY by ml/evaluate.py. `answer` is dropped and never saved.
  german_kb.csv     80% of the German topic file (no answers) for the Miscellaneous tree branch
  split_manifest.json
Run: python -m ml.split [--primary PATH --extra PATH --german PATH] [--no-extra]
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd

from ml import config as C
from ml import data


def make_split(df: pd.DataFrame):
    df = df.sample(frac=1.0, random_state=C.SEED).reset_index(drop=True)
    df.insert(0, "ticket_id", [f"TKT-{i:05d}" for i in range(len(df))])
    n_kb = int(len(df) * C.KB_FRAC)
    kb, test = df.iloc[:n_kb].copy(), df.iloc[n_kb:].copy()
    kb["is_val"] = False
    kb.iloc[int(len(kb) * (1 - C.KB_VAL_FRAC)):, kb.columns.get_loc("is_val")] = True
    return kb.reset_index(drop=True), test.reset_index(drop=True)


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(primary=None, extra=None, german=None, use_extra=True, out: Path = C.SPLIT_DIR) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    df = data.load_main(primary, extra, use_extra)
    kb, test = make_split(df)

    kb.to_csv(out / "kb_train.csv", index=False)
    test[["ticket_id", "subject", "body"]].to_csv(out / "test_inputs.csv", index=False)
    lab_cols = [c for c in ("ticket_id", "type", "queue", "priority", "language") if c in test]
    test[lab_cols].to_csv(out / "test_labels.csv", index=False)  # answer deliberately not saved

    manifest = {
        "seed": C.SEED, "kb_frac": C.KB_FRAC, "kb_val_frac": C.KB_VAL_FRAC,
        "source": {"repo": C.HF_REPO, "revision": C.HF_REVISION,
                   "files": [C.PRIMARY_FILE] + ([C.EXTRA_FILE] if use_extra else [])},
        "dedupe": "normalised-body, primary file wins",
        "rows": {"total": len(df), "kb": len(kb), "kb_val": int(kb["is_val"].sum()), "test": len(test)},
        "priority_map": C.PRIORITY_MAP,
        "labels_kb": data.label_report(kb),
        "test_id_range": [test["ticket_id"].iloc[0], test["ticket_id"].iloc[-1]],
    }
    try:  # German topic file: independent deterministic 80/20, only the 80% is ever indexed
        g = data.load_german(german)
        g = g.sample(frac=1.0, random_state=C.SEED).reset_index(drop=True)
        g.insert(0, "ticket_id", [f"DE-{i:05d}" for i in range(len(g))])
        g_kb = g.iloc[: int(len(g) * C.KB_FRAC)]
        g_kb.drop(columns=[c for c in ("answer",) if c in g_kb]).to_csv(out / "german_kb.csv", index=False)
        manifest["rows"]["german_kb"] = len(g_kb)
        manifest["source"]["files"].append(C.GERMAN_FILE)
    except Exception as e:  # offline / file missing: main split is still valid
        manifest["german_skipped"] = repr(e)
    for f in ("kb_train.csv", "test_inputs.csv", "test_labels.csv"):
        manifest.setdefault("sha256", {})[f] = _sha(out / f)
    (out / "split_manifest.json").write_text(json.dumps(manifest, indent=2, default=str))
    return manifest


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--primary"); ap.add_argument("--extra"); ap.add_argument("--german")
    ap.add_argument("--no-extra", action="store_true")
    a = ap.parse_args()
    m = run(a.primary and Path(a.primary), a.extra and Path(a.extra),
            a.german and Path(a.german), not a.no_extra)
    print(json.dumps(m["rows"], indent=2))
