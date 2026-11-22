"""ML-14: hierarchical retrieval quality, routing and thresholds (also answers "why hierarchical?").

Queries = kb_val rows; corpus = KB-train precedents only (a query never sees itself); queue probabilities come
from the calibrated classifier. A top-1 hit is "useful" when it shares queue AND type with the query.
Reports flat vs hierarchical: useful@1, agreement@5, routing accuracy (true queue among routed queues),
fallback rate. Tunes the routing weight `alpha` and picks `min_top1_similarity` (lowest flat top-1 similarity
whose accepted set reaches --precision). Writes reports/v1/retrieval_quality.json and the routing/threshold
keys into models/v1/thresholds.json. queried_count is not used for ranking (telemetry only).
Run: python -m ml.indexing.retrieval_quality [--precision 0.8]
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from engine.app.analyze.classify import Classifier
from ml import config as C
from ml import train as T
from ml.indexing import hierarchy, offline

K = 5
ALPHAS = (0.3, 0.45, 0.6, 0.75, 0.9)


def pick_threshold(top1: np.ndarray, useful: np.ndarray, precision: float) -> dict:
    floor = max(20, int(0.02 * len(top1)))
    for thr in np.round(np.arange(0.0, 1.0, 0.005), 3):
        acc = top1 >= thr
        if acc.sum() < floor:
            break
        p = float(useful[acc].mean())
        if p >= precision:
            return {"threshold": float(thr), "precision": p, "coverage": float(acc.mean())}
    cands = []
    for thr in np.round(np.arange(0.0, 1.0, 0.01), 2):
        acc = top1 >= thr
        if acc.sum() >= floor:
            cands.append((float(useful[acc].mean()), float(thr), float(acc.mean())))
    p, thr, cov = max(cands)
    return {"threshold": thr, "precision": p, "coverage": cov, "note": "target precision unreachable"}


def run(precision: float = 0.80, k: int = K) -> dict:
    kb, vecs = offline.load_kb()
    keep = kb["answer"].astype(str).str.strip().ne("") & kb["type"].astype(str).str.strip().ne("")
    kb, vecs = kb[keep].reset_index(drop=True), vecs[keep.values]
    tr = ~kb["is_val"].values
    train, val = kb[tr].reset_index(drop=True), kb[~tr].reset_index(drop=True)
    Dtr, Qva = vecs[tr], vecs[~tr]
    col = lambda df, c: df[c].to_numpy(dtype=object)  # noqa: E731

    nodes = hierarchy.build_queue_nodes(hierarchy.prepare_chunks(train), Dtr)
    names = [n["queue"] for n in nodes]
    cent = np.stack([n["vector"] for n in nodes])
    clf = Classifier.load(C.MODEL_DIR)
    qh = clf.heads["queue"]
    qp = clf.base_probs(T.texts_of(val))["queue"]
    qprobs = np.stack([qp[:, list(qh["classes"]).index(q)] if q in qh["classes"] else np.zeros(len(val))
                       for q in names], axis=1)

    def useful_at(idx):
        return (col(train, "queue")[idx[:, 0]] == col(val, "queue")) & (col(train, "type")[idx[:, 0]] == col(val, "type"))

    fsims, fidx = offline.topk(Qva, Dtr, k)
    f_useful = useful_at(fidx)
    out = {"n_queries": len(val), "k": k, "queues": names,
           "flat": {"useful@1": float(f_useful.mean()), f"hit@{k}": float(
               ((col(train, "queue")[fidx] == col(val, "queue")[:, None]) &
                (col(train, "type")[fidx] == col(val, "type")[:, None])).any(1).mean()),
               "mean_top1_sim": float(fsims[:, 0].mean())}}
    sel = pick_threshold(fsims[:, 0], f_useful, precision)
    out["min_top1_similarity"] = sel

    grid = {}
    for a in ALPHAS:
        hidx, hsims, fb, routed = offline.hier_search(Qva, Dtr, col(train, "queue"), cent, names, qprobs, a, k,
                                                      min_top1=sel["threshold"])
        truth = [names.index(q) if q in names else -1 for q in val["queue"]]
        grid[a] = {"routing_accuracy": float(np.mean([t in r for t, r in zip(truth, routed)])),
                   "useful@1": float(useful_at(hidx).mean()),
                   f"agreement@{k}": float(np.mean([len(set(x) & set(y)) / k for x, y in zip(hidx, fidx)])),
                   "fallback_rate": float(fb.mean())}
    best = max(grid, key=lambda a: (round(grid[a]["useful@1"], 4), grid[a]["routing_accuracy"]))
    out["hierarchical"] = {"by_alpha": {str(a): v for a, v in grid.items()}, "best_alpha": best}

    C.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (C.REPORT_DIR / "retrieval_quality.json").write_text(json.dumps(out, indent=2))
    th_path = C.MODEL_DIR / "thresholds.json"
    if th_path.exists():
        th = json.loads(th_path.read_text())
        th.update({"retrieval_threshold": sel["threshold"], "route_alpha": best, "route_top_n": 2,
                   "route_confident": 0.80, "fallback_margin": 0.05})
        th_path.write_text(json.dumps(th, indent=2))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--precision", type=float, default=0.80)
    print(json.dumps(run(ap.parse_args().precision), indent=2))
