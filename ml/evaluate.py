"""ML-11: holdout evaluation. The ONLY place test labels are read.

Inference sees test_inputs.csv only (ticket_id, subject, body). Labels are joined at the very end for scoring.
Reports per-target macro-F1/accuracy/ECE, High-Priority Incident Recall, and (with --blend) the retrieval-vote
ensemble using KB neighbours. Writes reports/v1/metrics.json.   Run: python -m ml.evaluate [--blend]
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd
from sklearn.metrics import classification_report

from engine.app.analyze.classify import TARGETS, Classifier
from ml import config as C
from ml import metrics as M
from ml import train as T
from ml.indexing import offline


def run(blend: bool = False) -> dict:
    inputs = pd.read_csv(C.SPLIT_DIR / "test_inputs.csv", keep_default_na=False)
    assert list(inputs.columns) == ["ticket_id", "subject", "body"], "test inputs must not carry labels"
    clf = Classifier.load(C.MODEL_DIR)
    probs = clf.base_probs(T.texts_of(inputs))
    w = clf.th.get("blend_weight", 0.0) if blend else 0.0
    if w:
        kb, vecs = offline.load_kb()
        tvecs = np.load(C.EMB_DIR / "test_768.npy")
        sims, idx = offline.topk(tvecs, vecs, clf.th.get("blend_k", 5))
        for t in TARGETS:
            classes = list(clf.heads[t]["classes"])
            vote = offline.vote_matrix(sims, idx, kb[t].values, classes)
            probs[t] = np.where(vote.sum(1, keepdims=True) > 0, (1 - w) * probs[t] + w * vote, probs[t])

    labels = pd.read_csv(C.SPLIT_DIR / "test_labels.csv", keep_default_na=False).set_index("ticket_id")
    y = labels.loc[inputs["ticket_id"]]
    report, pred = {}, {}
    for t in TARGETS:
        classes = list(clf.heads[t]["classes"])
        pred[t] = np.array(classes)[probs[t].argmax(1)]
        yi = np.array([classes.index(v) if v in classes else -1 for v in y[t]])
        ok = yi >= 0
        report[t] = {**M.summarize(y[t].values, pred[t]), "ece": M.ece(probs[t][ok], yi[ok]),
                     "per_class": classification_report(y[t].values, pred[t], output_dict=True, zero_division=0)}
    pi = list(clf.heads["priority"]["classes"])
    p_high = probs["priority"][:, pi.index("high")]
    ti = list(clf.heads["type"]["classes"])
    p_inc = probs["type"][:, ti.index("Incident")]
    hi_thr, inc_thr = clf.th["priority_high_threshold"], clf.th.get("incident_threshold", 0.5)
    flagged = (p_inc >= inc_thr) & (p_high >= hi_thr)
    argmax_rule = M.hp_incident_recall(y["type"].values, y["priority"].values,
                                       (pred["type"] == "Incident") & (p_high >= hi_thr))
    out = {"n_test": len(inputs), "blend_weight": w, "targets": report,
           "high_priority_incident": M.hp_incident_recall(y["type"].values, y["priority"].values, flagged),
           "priority_high_threshold": hi_thr, "incident_threshold": inc_thr,
           "high_priority_incident_argmax_rule": argmax_rule}
    C.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (C.REPORT_DIR / "metrics.json").write_text(json.dumps(out, indent=2))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--blend", action="store_true")
    r = run(ap.parse_args().blend)
    print(json.dumps({t: {k: round(v, 4) for k, v in r["targets"][t].items() if k != "per_class"}
                      for t in TARGETS} | {"hp_incident": r["high_priority_incident"]}, indent=2))
