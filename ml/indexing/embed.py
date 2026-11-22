"""DA-03: embed the knowledge base (subject+body, 768d) with checkpoints every 2,000 rows.

Inputs : splits/v1/kb_train.csv, german_kb.csv (if present), test_inputs.csv (inputs only)
Outputs: embeddings/v1/kb_768.npy (+ kb_ids.json), test_768.npy (+ test_ids.json), manifest.json
Run: python -m ml.indexing.embed [--backend gemini|hash]   (resumable)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from engine.app.analyze.embedder import EMBED_DIM, EMBED_MODEL, get_embedder
from engine.app.analyze.textproc import build_text
from ml import config as C

CHECKPOINT_EVERY = 2000


def embed_frame(df: pd.DataFrame, embedder, ckpt: Path) -> np.ndarray:
    """Embed df rows in order, resuming from `ckpt` shards (part_00000.npy, ...)."""
    ckpt.mkdir(parents=True, exist_ok=True)
    texts = [build_text(s, b) for s, b in zip(df["subject"], df["body"])]
    parts = []
    for n, start in enumerate(range(0, len(texts), CHECKPOINT_EVERY)):
        shard = ckpt / f"part_{n:05d}.npy"
        if shard.exists():
            parts.append(np.load(shard))
            continue
        v = embedder.embed(texts[start:start + CHECKPOINT_EVERY])
        np.save(shard, v)
        parts.append(v)
        print(f"  embedded {min(start + CHECKPOINT_EVERY, len(texts))}/{len(texts)}")
    return np.vstack(parts) if parts else np.zeros((0, EMBED_DIM), np.float32)


def run(backend: str | None = None, split_dir: Path = C.SPLIT_DIR, out: Path = C.EMB_DIR) -> dict:
    emb = get_embedder(backend)
    out.mkdir(parents=True, exist_ok=True)
    kb = pd.read_csv(split_dir / "kb_train.csv", keep_default_na=False)
    frames = [kb[["ticket_id", "subject", "body"]]]
    g = split_dir / "german_kb.csv"
    if g.exists():
        frames.append(pd.read_csv(g, keep_default_na=False)[["ticket_id", "subject", "body"]])
    kb_all = pd.concat(frames, ignore_index=True)
    test = pd.read_csv(split_dir / "test_inputs.csv", keep_default_na=False)

    kb_vec = embed_frame(kb_all, emb, out / f"_ckpt_kb_{emb.name}")
    test_vec = embed_frame(test, emb, out / f"_ckpt_test_{emb.name}")
    np.save(out / "kb_768.npy", kb_vec)
    np.save(out / "test_768.npy", test_vec)
    (out / "kb_ids.json").write_text(json.dumps(kb_all["ticket_id"].tolist()))
    (out / "test_ids.json").write_text(json.dumps(test["ticket_id"].tolist()))
    man = {"backend": emb.name, "model": getattr(emb, "model", "hash"),
           "dim": int(kb_vec.shape[1]), "kb_rows": len(kb_all), "test_rows": len(test),
           "text": "subject + newline + body (subject omitted when empty)", "normalised": True}
    (out / "manifest.json").write_text(json.dumps(man, indent=2))
    return man


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["auto", "openai", "gemini", "hash"])
    print(json.dumps(run(ap.parse_args().backend), indent=2))
