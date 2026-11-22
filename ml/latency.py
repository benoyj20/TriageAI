"""ML-12: per-stage latency benchmark (language, classify, embed, retrieve) over test inputs.

Retrieval runs with count=False so the benchmark never changes queried_count.
Run: python -m ml.latency [--n 200] [--url redis://:<pw>@localhost:6379]    (retrieval skipped if Redis unreachable)
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np
import pandas as pd

from engine.app.analyze.classify import Classifier
from engine.app.analyze.embedder import get_embedder
from engine.app.analyze.language import detect_language
from engine.app.retrieval.search import connect, load_queue_nodes, retrieve
from engine.app.analyze.textproc import build_text
from ml import config as C


def pct(xs):
    a = np.array(xs) * 1000
    return {"p50_ms": round(float(np.percentile(a, 50)), 1), "p95_ms": round(float(np.percentile(a, 95)), 1),
            "mean_ms": round(float(a.mean()), 1)}


def run(n: int = 200, url: str | None = None) -> dict:
    df = pd.read_csv(C.SPLIT_DIR / "test_inputs.csv", keep_default_na=False).head(n)
    clf, emb = Classifier.load(C.MODEL_DIR), get_embedder()
    t_lang, t_clf, t_emb, t_ret = [], [], [], []
    r, nodes = None, []
    try:
        r = connect(url or C.REDIS_URL)
        r.ping()
        nodes = load_queue_nodes(r)
    except Exception:
        r = None
    clf.predict("warm", "warm up")
    for s, b in zip(df["subject"], df["body"]):
        text = build_text(s, b)
        t = time.perf_counter(); detect_language(text); t_lang.append(time.perf_counter() - t)
        t = time.perf_counter(); out = clf.predict(s, b); t_clf.append(time.perf_counter() - t)
        t = time.perf_counter(); q = emb.embed([text])[0]; t_emb.append(time.perf_counter() - t)
        if r:
            qp = {c: p for c, p in out["queue"]["probs"].items()}
            t = time.perf_counter()
            retrieve(r, q, nodes, qp, count=False, min_top1_similarity=clf.th.get("retrieval_threshold", 0.0))
            t_ret.append(time.perf_counter() - t)
    out = {"n": len(df), "language": pct(t_lang), "classify": pct(t_clf), "embed": pct(t_emb)}
    if t_ret:
        out["retrieve"] = pct(t_ret)
    else:
        out["retrieve"] = "skipped (Redis unreachable)"
    C.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (C.REPORT_DIR / "latency.json").write_text(json.dumps(out, indent=2))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--url")
    print(json.dumps(run(ap.parse_args().n, ap.parse_args().url), indent=2))
