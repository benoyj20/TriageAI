"""ML-05 / ML-09 / ML-10: baseline classifiers, temperature calibration, high-priority threshold.

TF-IDF (word 1-2 + char_wb 3-5) -> one logistic-regression head each for type, queue, priority.
Fit on KB train (is_val == False). Temperature + priority threshold are tuned on kb_val (last 10% of the KB).
The 20% test split is never touched here.

Run: python -m ml.train [--recall-target 0.90]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from engine.app.analyze.classify import TARGETS, softmax_T
from engine.app.analyze.features import WordChar
from engine.app.analyze.textproc import build_text
from ml import config as C
from ml import metrics as M


def texts_of(df: pd.DataFrame) -> list[str]:
    return [build_text(s, b) for s, b in zip(df["subject"], df["body"])]


def fit_temperature(logp: np.ndarray, y_idx: np.ndarray) -> float:
    grid = np.round(np.arange(0.3, 5.01, 0.05), 2)
    return float(min(grid, key=lambda T: M.nll(softmax_T(logp, T), y_idx)))


def tune_priority_threshold(p_high, p_inc, true_type, true_prio, recall_target) -> dict:
    """Two-threshold rule: flag when P(Incident) >= inc_thr AND P(high) >= high_thr.

    Among pairs whose high-priority-incident recall on val meets the target, keep the most precise one (the lowest
    flag rate). If the target is unreachable, fall back to the pair with the best recall at precision >= 0.2.
    Requiring argmax(type)==Incident instead caps recall (about 0.85 here), hence P(Incident) with its own threshold.
    """
    best, fallback = None, None
    for inc in np.round(np.arange(0.05, 0.61, 0.05), 2):
        for hi in np.round(np.arange(0.05, 0.91, 0.01), 2):
            r = M.hp_incident_recall(true_type, true_prio, (p_inc >= inc) & (p_high >= hi))
            if r["recall"] is None:
                continue
            cand = {"incident_threshold": float(inc), "threshold": float(hi), **r}
            if r["recall"] >= recall_target and (best is None or r["precision"] > best["precision"]):
                best = cand
            if (r["precision"] or 0) >= 0.2 and (fallback is None or r["recall"] > fallback["recall"]):
                fallback = cand
    if best:
        return best
    if fallback:
        return {**fallback, "note": f"recall target {recall_target} unreachable; best recall at precision >= 0.2"}
    return {"incident_threshold": 0.3, "threshold": 0.5, "note": "no positives in val"}


def _val_probs(model_dir: Path, va: pd.DataFrame) -> dict:
    from engine.app.analyze.classify import Classifier
    return Classifier.load(model_dir).base_probs(texts_of(va))


def tune_and_save(probs: dict, heads: dict, va: pd.DataFrame, model_dir: Path, recall_target: float) -> dict:
    pi, ti = list(heads["priority"]["classes"]), list(heads["type"]["classes"])
    p_high = probs["priority"][:, pi.index("high")] if "high" in pi else np.zeros(len(va))
    p_inc = probs["type"][:, ti.index("Incident")] if "Incident" in ti else np.zeros(len(va))
    tuned = tune_priority_threshold(p_high, p_inc, va["type"].values, va["priority"].values, recall_target)
    path = model_dir / "thresholds.json"
    th = json.loads(path.read_text()) if path.exists() else {"blend_weight": 0.0}
    th.update({"priority_high_threshold": tuned["threshold"], "incident_threshold": tuned["incident_threshold"],
               "recall_target": recall_target, "val_hp_incident": tuned})
    path.write_text(json.dumps(th, indent=2))
    return tuned


def retune(recall_target: float = 0.90, split_dir: Path = C.SPLIT_DIR, model_dir: Path = C.MODEL_DIR) -> dict:
    """Re-tune only the priority/incident thresholds from the saved model (no retraining)."""
    import joblib as _jl
    kb = pd.read_csv(split_dir / "kb_train.csv", keep_default_na=False)
    va = kb[kb["is_val"].astype(str).str.lower().eq("true")]
    heads = _jl.load(model_dir / "classifier.joblib")["heads"]
    return tune_and_save(_val_probs(model_dir, va), heads, va, model_dir, recall_target)


def train(split_dir: Path = C.SPLIT_DIR, model_dir: Path = C.MODEL_DIR, recall_target: float = 0.90,
          max_iter: int = 300) -> dict:
    kb = pd.read_csv(split_dir / "kb_train.csv", keep_default_na=False)
    kb["is_val"] = kb["is_val"].astype(str).str.lower().eq("true")
    tr, va = kb[~kb["is_val"]], kb[kb["is_val"]]
    vec = WordChar().fit(texts_of(tr))
    Xtr, Xva = vec.transform(texts_of(tr)), vec.transform(texts_of(va))

    heads, report, val_probs = {}, {}, {}
    for t in TARGETS:
        clf = LogisticRegression(max_iter=max_iter, C=4.0, class_weight="balanced")
        clf.fit(Xtr, tr[t])
        classes = list(clf.classes_)
        y = np.array([classes.index(v) if v in classes else -1 for v in va[t]])
        ok = y >= 0
        logp = clf.predict_log_proba(Xva)
        T = fit_temperature(logp[ok], y[ok])
        p = softmax_T(logp, T)
        val_probs[t] = p
        heads[t] = {"clf": clf, "classes": classes, "temperature": T}
        report[t] = {**M.summarize(va[t][ok], np.array(classes)[p[ok].argmax(1)]), "temperature": T,
                     "ece_before": M.ece(softmax_T(logp[ok], 1.0), y[ok]), "ece_after": M.ece(p[ok], y[ok])}

    model_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump({"vectorizer": vec, "heads": heads}, model_dir / "classifier.joblib")
    (model_dir / "thresholds.json").write_text(json.dumps({"blend_weight": 0.0}))
    tuned = tune_and_save(val_probs, heads, va, model_dir, recall_target)
    labels = {t: heads[t]["classes"] for t in TARGETS}
    (model_dir / "labels.json").write_text(json.dumps(labels, indent=2))
    out = {"rows": {"train": len(tr), "val": len(va)}, "val": report, "priority_threshold": tuned}
    C.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (C.REPORT_DIR / "train_val_report.json").write_text(json.dumps(out, indent=2))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--recall-target", type=float, default=0.90)
    ap.add_argument("--retune-only", action="store_true", help="re-tune thresholds from the saved model")
    a = ap.parse_args()
    print(json.dumps(retune(a.recall_target) if a.retune_only else train(recall_target=a.recall_target), indent=2))
