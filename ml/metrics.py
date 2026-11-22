"""Metrics shared by train / tune / evaluate."""
from __future__ import annotations

import numpy as np
from sklearn.metrics import accuracy_score, f1_score


def ece(probs: np.ndarray, y_idx: np.ndarray, bins: int = 10) -> float:
    """Expected calibration error on top-1 confidence."""
    conf, pred = probs.max(axis=1), probs.argmax(axis=1)
    hit = (pred == y_idx).astype(float)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf > lo) & (conf <= hi)
        if m.any():
            total += m.mean() * abs(hit[m].mean() - conf[m].mean())
    return float(total)


def nll(probs: np.ndarray, y_idx: np.ndarray) -> float:
    return float(-np.log(np.clip(probs[np.arange(len(y_idx)), y_idx], 1e-12, None)).mean())


def summarize(y_true, y_pred) -> dict:
    return {"macro_f1": float(f1_score(y_true, y_pred, average="macro", zero_division=0)),
            "accuracy": float(accuracy_score(y_true, y_pred))}


def hp_incident_recall(true_type, true_prio, flagged) -> dict:
    """High-Priority Incident Recall: of true (Incident & high) tickets, what share did we flag?"""
    t = (np.asarray(true_type) == "Incident") & (np.asarray(true_prio) == "high")
    flagged = np.asarray(flagged, dtype=bool)
    n = int(t.sum())
    return {"recall": float(flagged[t].mean()) if n else None, "support": n,
            "precision": float(t[flagged].mean()) if flagged.any() else None,
            "flag_rate": float(flagged.mean())}
