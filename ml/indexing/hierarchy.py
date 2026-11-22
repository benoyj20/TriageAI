"""Level-1 / level-2 records for the Redis index (README "Hierarchical RAG").

prepare_chunks(): normalise a KB frame into chunk rows (tags -> "a,b,c", precedent flag, German topic rows ->
queue "Miscellaneous"). build_queue_nodes(): per-queue chunk_count, type_mix, top_tags and a unit centroid,
computed from KB chunks only.
"""
from __future__ import annotations

import json
from collections import Counter

import numpy as np
import pandas as pd

from engine.app.retrieval.schema import MISC


def _tags(row: dict) -> list[str]:
    out = []
    for i in range(1, 9):
        v = row.get(f"tag_{i}")
        if isinstance(v, str) and v.strip() and v.strip().lower() != "nan":
            out.append(v.strip().replace(",", " "))  # comma is the TAG separator
    return out


def prepare_chunks(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    for col in ("type", "answer", "language"):   # the German topic file lacks these
        if col not in df:
            df[col] = ""
    df["tags_list"] = [_tags(r) for r in df.to_dict("records")]
    df["tags"] = df["tags_list"].map(",".join)
    type_ok = df["type"].fillna("").astype(str).str.strip().ne("")
    ans_ok = df["answer"].fillna("").astype(str).str.strip().ne("") if "answer" in df else False
    df["precedent"] = type_ok & ans_ok
    df["queue_node"] = np.where(df["precedent"], df["queue"], MISC)  # German topic rows -> Miscellaneous
    return df


def build_queue_nodes(df: pd.DataFrame, vectors: np.ndarray) -> list[dict]:
    """`df` must come from prepare_chunks and be row-aligned with `vectors`."""
    nodes = []
    for queue, idx in df.groupby("queue_node").indices.items():
        sub = df.iloc[idx]
        c = vectors[idx].mean(axis=0)
        c = (c / max(np.linalg.norm(c), 1e-12)).astype(np.float32)
        tags = Counter(t for ts in sub["tags_list"] for t in ts).most_common(10)
        nodes.append({
            "queue": queue, "chunk_count": len(idx),
            "type_mix": json.dumps(dict(Counter(sub["type"].replace("", "unknown")))),
            "top_tags": ",".join(t for t, _ in tags), "queried_count": 0, "vector": c})
    return nodes
