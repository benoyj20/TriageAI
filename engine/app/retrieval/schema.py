"""Redis layout for the hierarchical RAG index (README: "Hierarchical RAG"). Shared by the builder and the engine.

Level 2: one hash per ticket  `chunk:<ticket_id>`   -> indexed by `idx:chunks` (HNSW cosine over vector_embedding)
Level 1: one hash per queue   `queue:<slug>`        -> centroid vector + counts, loaded into memory at boot
`precedent` ("1"/"0") is an addition to the README field list: German topic rows have no answer, so they are
indexed under queue "Miscellaneous" with precedent=0 and every citation search filters on precedent=1.
"""
from __future__ import annotations

import os
import re

import numpy as np

CHUNK_INDEX = os.getenv("REDIS_CHUNK_INDEX", "idx:chunks")
CHUNK_PREFIX = os.getenv("REDIS_CHUNK_PREFIX", "chunk:")
QUEUE_PREFIX = os.getenv("REDIS_QUEUE_PREFIX", "queue:")
EMBED_DIM = int(os.getenv("EMBED_DIM", "768"))
MISC = "Miscellaneous"
VEC = "vector_embedding"


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "unnamed"


def chunk_key(ticket_id: str) -> str:
    return f"{CHUNK_PREFIX}{ticket_id}"


def queue_key(queue: str) -> str:
    return f"{QUEUE_PREFIX}{slug(queue)}"


def to_bytes(v) -> bytes:
    return np.asarray(v, dtype=np.float32).tobytes()


def from_bytes(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype=np.float32)


def create_index_args(dim: int = EMBED_DIM, index: str = CHUNK_INDEX, prefix: str = CHUNK_PREFIX) -> list:
    """FT.CREATE arguments exactly as in the README (+ the precedent TAG)."""
    return [
        "FT.CREATE", index, "ON", "HASH", "PREFIX", 1, prefix, "SCHEMA",
        "ticket_id", "TAG", "queue", "TAG", "type", "TAG", "priority", "TAG", "language", "TAG",
        "precedent", "TAG", "tags", "TAG", "SEPARATOR", ",", "queried_count", "NUMERIC", "SORTABLE",
        VEC, "VECTOR", "HNSW", 6, "TYPE", "FLOAT32", "DIM", dim, "DISTANCE_METRIC", "COSINE",
    ]
