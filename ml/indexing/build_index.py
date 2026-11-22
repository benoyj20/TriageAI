"""ML-08: load the hierarchy into Redis (idx:chunks + queue nodes) and snapshot it.

Level 2: `chunk:<ticket_id>` hashes (vector_embedding = subject+body embedding, queried_count = 0)
Level 1: `queue:<slug>` hashes (centroid vector, chunk_count, type_mix, top_tags)
Only the 80% KB is loaded (plus the German topic rows under queue "Miscellaneous", precedent=0).

Run: python -m ml.indexing.build_index [--url redis://:<pw>@localhost:6379] [--snapshot]
Needs Redis Stack / Redis 8 (Query Engine). Port 6379 must stay private.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import redis

from engine.app.retrieval import schema as S
from engine.app.retrieval.search import connect
from ml import config as C
from ml.indexing import hierarchy


def load_kb_frame(split_dir: Path = C.SPLIT_DIR) -> pd.DataFrame:
    frames = [pd.read_csv(split_dir / "kb_train.csv", keep_default_na=False)]
    g = split_dir / "german_kb.csv"
    if g.exists():
        frames.append(pd.read_csv(g, keep_default_na=False))
    df = pd.concat(frames, ignore_index=True, sort=False).fillna("")
    return df


def reset_keys(r: redis.Redis) -> None:
    try:
        r.execute_command("FT.DROPINDEX", S.CHUNK_INDEX)
    except redis.ResponseError:
        pass  # index did not exist
    for prefix in (S.CHUNK_PREFIX, S.QUEUE_PREFIX):
        keys = list(r.scan_iter(f"{prefix}*", count=1000))
        for i in range(0, len(keys), 1000):
            r.delete(*keys[i:i + 1000])


def chunk_mapping(rec: dict, vec: np.ndarray) -> dict:
    return {"ticket_id": rec["ticket_id"], "queue": rec["queue_node"], "type": rec.get("type", ""),
            "priority": rec.get("priority", ""), "subject": rec.get("subject", ""), "body": rec["body"],
            "tags": rec["tags"], "language": rec.get("language", ""), "answer": rec.get("answer", ""),
            "precedent": "1" if rec["precedent"] else "0", "queried_count": 0, S.VEC: S.to_bytes(vec)}


def wait_indexed(r: redis.Redis, timeout: float = 600) -> int:
    t0 = time.time()
    while time.time() - t0 < timeout:
        info = r.ft(S.CHUNK_INDEX).info()
        if float(info.get("percent_indexed", 1)) >= 1 and int(info.get("indexing", 0)) == 0:
            return int(info["num_docs"])
        time.sleep(0.5)
    raise TimeoutError("Redis index did not finish building")


def snapshot(r: redis.Redis, timeout: float = 300) -> dict:
    """BGSAVE and wait. The dump.rdb lives in Redis' data dir; copying it to R2 (redis/dump_v1.rdb) is an infra step."""
    before = r.lastsave()
    r.bgsave()
    t0 = time.time()
    while r.lastsave() == before:
        if time.time() - t0 > timeout:
            raise TimeoutError("BGSAVE did not finish")
        time.sleep(0.5)
    return {"lastsave": str(r.lastsave()), "dir": r.config_get("dir").get("dir"),
            "dbfilename": r.config_get("dbfilename").get("dbfilename")}


def build(r: redis.Redis, split_dir: Path = C.SPLIT_DIR, emb_dir: Path = C.EMB_DIR, batch: int = 500) -> dict:
    man = json.loads((emb_dir / "manifest.json").read_text())
    vectors = np.load(emb_dir / "kb_768.npy")
    ids = json.loads((emb_dir / "kb_ids.json").read_text())
    df = load_kb_frame(split_dir)
    assert df["ticket_id"].tolist() == ids, "embeddings are not aligned with the KB split; re-run embed"
    assert vectors.shape[1] == S.EMBED_DIM == man["dim"], "embedding dimension mismatch"
    df = hierarchy.prepare_chunks(df)
    nodes = hierarchy.build_queue_nodes(df, vectors)

    reset_keys(r)
    r.execute_command(*S.create_index_args(vectors.shape[1]))
    recs = df.to_dict("records")
    for i in range(0, len(recs), batch):
        pipe = r.pipeline(transaction=False)
        for j, rec in enumerate(recs[i:i + batch]):
            pipe.hset(S.chunk_key(rec["ticket_id"]), mapping=chunk_mapping(rec, vectors[i + j]))
        pipe.execute()
    pipe = r.pipeline(transaction=False)
    for n in nodes:
        pipe.hset(S.queue_key(n["queue"]), mapping={
            "queue": n["queue"], "chunk_count": n["chunk_count"], "type_mix": n["type_mix"],
            "top_tags": n["top_tags"], "queried_count": 0, S.VEC: S.to_bytes(n["vector"])})
    pipe.execute()
    r.hset("meta:embedding", mapping={"provider": man["backend"], "model": man.get("model", ""), "dim": man["dim"]})
    docs = wait_indexed(r)
    return {"chunks": len(df), "indexed_docs": docs, "precedents": int(df["precedent"].sum()),
            "queues": sorted(n["queue"] for n in nodes), "embed_backend": man["backend"],
            "used_memory_human": r.info("memory")["used_memory_human"]}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--snapshot", action="store_true")
    a = ap.parse_args()
    r = connect(a.url or C.REDIS_URL)
    print(json.dumps(build(r), indent=2))
    if a.snapshot:
        print("snapshot:", json.dumps(snapshot(r)))
