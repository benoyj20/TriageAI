"""ML-07/08/09/10 serving side: calibrated multi-task classifier + retrieval-vote ensemble.

Model bundle (models/v1/): classifier.joblib {vectorizer, heads{target:{clf, classes, temperature}}} and
thresholds.json {priority_high_threshold, blend_weight, ...}. Produced by ml/train.py.

    clf = Classifier.load(MODEL_DIR)
    out = clf.predict(subject, body, hits=retrieval.hits)   # hits optional (ML-08 blend)
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import joblib
import numpy as np

from engine.app.analyze.textproc import build_text

TARGETS = ("type", "queue", "priority")
DEFAULT_MODEL_DIR = Path(os.getenv("MODEL_DIR", "ml/artifacts/models/v1"))


def softmax_T(logp: np.ndarray, T: float) -> np.ndarray:
    z = logp / max(T, 1e-3)
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def vote_probs(hits, classes: list[str], key: str, power: float = 2.0) -> np.ndarray | None:
    """Similarity-weighted label distribution over retrieved precedents (None if no usable hits)."""
    v = np.zeros(len(classes))
    idx = {c: i for i, c in enumerate(classes)}
    for h in hits or []:
        lab = h.payload.get(key)
        if lab in idx:
            v[idx[lab]] += max(h.score, 0.0) ** power
    s = v.sum()
    return v / s if s > 0 else None


class Classifier:
    def __init__(self, bundle: dict, thresholds: dict):
        self.vec, self.heads, self.th = bundle["vectorizer"], bundle["heads"], thresholds

    @classmethod
    def load(cls, model_dir: Path = DEFAULT_MODEL_DIR) -> "Classifier":
        model_dir = Path(model_dir)
        return cls(joblib.load(model_dir / "classifier.joblib"),
                   json.loads((model_dir / "thresholds.json").read_text()))

    def base_probs(self, texts: list[str]) -> dict[str, np.ndarray]:
        X = self.vec.transform(texts)
        return {t: softmax_T(h["clf"].predict_log_proba(X), h["temperature"]) for t, h in self.heads.items()}

    def predict(self, subject, body, hits=None) -> dict:
        probs = {t: p[0] for t, p in self.base_probs([build_text(subject, body)]).items()}
        w = self.th.get("blend_weight", 0.0)
        out = {}
        for t in TARGETS:
            classes = list(self.heads[t]["classes"])
            p = probs[t]
            vote = vote_probs(hits, classes, t) if w and hits else None
            if vote is not None:
                p = (1 - w) * p + w * vote
            i = int(np.argmax(p))
            out[t] = {"label": classes[i], "confidence": float(p[i]),
                      "probs": {c: float(x) for c, x in zip(classes, p)}}
        pc = out["priority"]["probs"]
        p_high = pc.get("high", 0.0)
        thr = self.th.get("priority_high_threshold", 0.5)
        out["priority_high_prob"] = p_high
        out["priority_high_threshold"] = thr
        # Recall-tuned rule: P(Incident) >= incident_threshold AND P(high) >= priority_high_threshold.
        # (gate.py currently tests argmax type == Incident; see ml/PROGRESS.md for the recommended change.)
        p_inc = out["type"]["probs"].get("Incident", 0.0)
        inc_thr = self.th.get("incident_threshold", 0.5)
        out["incident_prob"], out["incident_threshold"] = p_inc, inc_thr
        out["high_priority_incident"] = p_inc >= inc_thr and p_high >= thr
        return out
