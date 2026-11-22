"""ML-08: choose the weight of the retrieval-vote ensemble on kb_val.

p_final = (1 - w) * p_classifier + w * p_vote(top-k precedents). One w for all heads, picked by mean macro-F1
over type/queue/priority (ties broken by lower NLL). Neighbours come from KB-train only (val rows are queries).
Writes `blend_weight` into models/v1/thresholds.json.   Run: python -m ml.tune_blend
"""
from __future__ import annotations

import json

import numpy as np

from engine.app.analyze.classify import TARGETS, Classifier
from ml import config as C
from ml import metrics as M
from ml import train as T
from ml.indexing import offline

K = 5


def run(k: int = K) -> dict:
    kb, vecs = offline.load_kb()
    clf = Classifier.load(C.MODEL_DIR)
    tr_mask = ~kb["is_val"].values
    va = kb[~tr_mask]
    sims, idx = offline.topk(vecs[~tr_mask], vecs[tr_mask], k)
    base = clf.base_probs(T.texts_of(va))
    train_rows = kb[tr_mask]
    scores = {}
    for w in np.round(np.arange(0.0, 1.01, 0.1), 1):
        f1s, nlls = [], []
        for t in TARGETS:
            classes = list(clf.heads[t]["classes"])
            vote = offline.vote_matrix(sims, idx, train_rows[t].values, classes)
            has = vote.sum(1, keepdims=True) > 0
            p = np.where(has, (1 - w) * base[t] + w * vote, base[t])
            y = va[t].values
            f1s.append(M.summarize(y, np.array(classes)[p.argmax(1)])["macro_f1"])
            yi = np.array([classes.index(v) if v in classes else 0 for v in y])
            nlls.append(M.nll(p, yi))
        scores[float(w)] = {"mean_macro_f1": float(np.mean(f1s)), "mean_nll": float(np.mean(nlls))}
    best = max(scores, key=lambda w: (round(scores[w]["mean_macro_f1"], 4), -scores[w]["mean_nll"]))
    th_path = C.MODEL_DIR / "thresholds.json"
    th = json.loads(th_path.read_text())
    th["blend_weight"], th["blend_k"] = best, k
    th_path.write_text(json.dumps(th, indent=2))
    return {"best_w": best, "scores": scores}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
