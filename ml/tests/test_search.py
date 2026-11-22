"""Redis retriever: pure helpers always run; the live test needs Redis Stack (REDIS_URL) and skips otherwise."""
import os

import numpy as np
import pandas as pd
import pytest

from engine.app.retrieval import schema as S
from engine.app.retrieval.search import QueueNode, connect, load_queue_nodes, record_queries, retrieve, route, tag_escape, top_queried


def test_tag_escape():
    assert tag_escape("Technical Support") == r"Technical\ Support"
    assert tag_escape("Billing and Payments") == r"Billing\ and\ Payments"
    assert tag_escape("A/B-c.d") == r"A\/B\-c\.d"
    assert tag_escape("plain") == "plain"


def test_vector_bytes_roundtrip_and_keys():
    v = np.random.rand(S.EMBED_DIM).astype(np.float32)
    assert len(S.to_bytes(v)) == 4 * S.EMBED_DIM and np.allclose(S.from_bytes(S.to_bytes(v)), v)
    assert S.queue_key("Technical Support") == "queue:technical_support"
    assert S.chunk_key("TKT-00012") == "chunk:TKT-00012"
    args = S.create_index_args()
    assert args[1] == "idx:chunks" and "HNSW" in args and "COSINE" in args and args[args.index("DIM") + 1] == S.EMBED_DIM


def test_route_top2_or_top1_when_confident():
    e = np.eye(3, dtype=np.float32)
    nodes = [QueueNode("A", 1, e[0]), QueueNode("B", 1, e[1]), QueueNode("C", 1, e[2])]
    keep, sc = route(e[0], nodes, {"A": 0.9, "B": 0.1}, alpha=0.6)
    assert keep == ["A"] and sc["A"] >= 0.8                       # confident -> only the top queue
    keep, _ = route(e[0], nodes, {"A": 0.4, "B": 0.35, "C": 0.25}, alpha=0.6)
    assert len(keep) == 2 and keep[0] == "A"                      # unsure -> top 2


redis_url = os.getenv("REDIS_URL")


@pytest.mark.skipif(not redis_url, reason="set REDIS_URL to a Redis Stack instance to run the live test")
def test_live_hierarchy_and_queried_count():
    from ml.indexing import build_index
    r = connect(redis_url)
    info = build_index.build(r)
    assert info["indexed_docs"] == info["chunks"]
    nodes = load_queue_nodes(r)
    kb = pd.read_csv(os.environ["ARTIFACTS_DIR"] + "/splits/v1/kb_train.csv", keep_default_na=False)
    from engine.app.analyze.embedder import get_embedder
    row = kb.iloc[0]
    q = get_embedder().embed([f"{row.subject}\n{row.body}" if row.subject else row.body])[0]
    res = retrieve(r, q, nodes, {row.queue: 1.0}, count=False)
    assert res.hits[0].ticket_id == row.ticket_id and not res.fallback_global
    assert top_queried(r) == []
    retrieve(r, q, nodes, {row.queue: 1.0}, count=True)
    assert int(r.hget(S.chunk_key(row.ticket_id), "queried_count")) == 1
    assert int(r.hget(S.queue_key(row.queue), "queried_count")) >= 1
    record_queries(r, res.hits[:1])
    assert int(r.hget(S.chunk_key(row.ticket_id), "queried_count")) == 2
