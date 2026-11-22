"""Brute-force numpy retrieval used for tuning/evaluation (no Qdrant needed, no queried_count side effects)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from ml import config as C


def load_kb(split_dir: Path = C.SPLIT_DIR, emb_dir: Path = C.EMB_DIR):
    """kb_train rows (is_val as bool) and their aligned embeddings. German rows are excluded (no precedents)."""
    kb = pd.read_csv(split_dir / "kb_train.csv", keep_default_na=False)
    kb["is_val"] = kb["is_val"].astype(str).str.lower().eq("true")
    vecs = np.load(emb_dir / "kb_768.npy")[: len(kb)]
    ids = json.loads((emb_dir / "kb_ids.json").read_text())[: len(kb)]
    assert ids == kb["ticket_id"].tolist(), "embeddings not aligned with kb_train.csv"
    return kb, vecs


def topk(Q: np.ndarray, D: np.ndarray, k: int = 5, chunk: int = 2048):
    """(sims, idx) of the k most similar rows of D for each row of Q (unit vectors -> dot = cosine)."""
    k = min(k, len(D))
    sims = np.empty((len(Q), k), np.float32)
    idx = np.empty((len(Q), k), np.int64)
    for s in range(0, len(Q), chunk):
        m = Q[s:s + chunk] @ D.T
        part = np.argpartition(-m, k - 1, axis=1)[:, :k]
        ps = np.take_along_axis(m, part, 1)
        order = np.argsort(-ps, axis=1)
        idx[s:s + chunk] = np.take_along_axis(part, order, 1)
        sims[s:s + chunk] = np.take_along_axis(ps, order, 1)
    return sims, idx


def vote_matrix(sims: np.ndarray, idx: np.ndarray, labels: np.ndarray, classes: list[str],
                power: float = 2.0) -> np.ndarray:
    """Per-query similarity-weighted label distribution (rows sum to 1, or 0 if no hit has a known label)."""
    pos = {c: i for i, c in enumerate(classes)}
    out = np.zeros((len(sims), len(classes)))
    for q in range(len(sims)):
        for s, j in zip(sims[q], idx[q]):
            c = pos.get(labels[j])
            if c is not None:
                out[q, c] += max(float(s), 0.0) ** power
    tot = out.sum(1, keepdims=True)
    return np.divide(out, tot, out=np.zeros_like(out), where=tot > 0)


def hier_search(Q, D, d_queue, cent, names, qprobs, alpha=0.6, k=5, top_n=2, confident=0.80,
                min_top1=0.0, margin=0.05, chunk=512):
    """numpy twin of engine/app/retrieval/search.retrieve (same routing + fallback rules).

    d_queue: queue name per row of D; cent/names: queue centroids; qprobs: (n, len(names)) classifier probs.
    Returns (idx, sims, fallback_mask, routed_idx_lists).
    """
    pos = {q: i for i, q in enumerate(names)}
    dq = np.array([pos.get(q, -1) for q in d_queue])
    n = len(Q)
    out_idx, out_sims = np.empty((n, k), np.int64), np.empty((n, k), np.float32)
    fb, routed_all = np.zeros(n, bool), []
    for s in range(0, n, chunk):
        m = Q[s:s + chunk] @ D.T
        cs = alpha * qprobs[s:s + chunk] + (1 - alpha) * (Q[s:s + chunk] @ cent.T)
        for r in range(len(m)):
            row = m[r]
            g = np.argpartition(-row, k - 1)[:k]
            g = g[np.argsort(-row[g])]
            order = np.argsort(-cs[r])
            routed = order[:1] if cs[r, order[0]] >= confident else order[:top_n]
            masked = np.where(np.isin(dq, routed), row, -np.inf)
            h = np.argpartition(-masked, k - 1)[:k]
            h = h[np.argsort(-masked[h])]
            bad = (not np.isfinite(masked[h[0]])) or row[h[0]] < min_top1 or row[h[0]] < row[g[0]] - margin
            sel = g if bad else h
            out_idx[s + r], out_sims[s + r], fb[s + r] = sel, row[sel], bad
            routed_all.append(set(routed.tolist()))
    return out_idx, out_sims, fb, routed_all
