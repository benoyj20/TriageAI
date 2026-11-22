"""Offline end-to-end test on synthetic tickets: split -> embed -> train -> tree/Qdrant -> retrieve -> eval."""
import json
import random

import numpy as np
import pandas as pd
import pytest

from engine.app.analyze.classify import Classifier
from engine.app.analyze.embedder import get_embedder
from engine.app.analyze.language import detect_language
from ml import config as C
from ml import evaluate, split, train, tune_blend
from ml.indexing import embed, hierarchy, offline, retrieval_quality

QUEUES = {"Technical Support": ["server", "outage", "vpn", "crash"], "Billing and Payments": ["invoice", "refund", "charge"],
          "Customer Service": ["account", "password", "login"], "Rare Queue": ["zeppelin", "origami"]}


def synth(n=1400, seed=1):
    rnd = random.Random(seed)
    rows = []
    for i in range(n):
        q = rnd.choices(list(QUEUES), weights=[4, 4, 4, 0.5])[0]
        typ = rnd.choice(["Incident", "Request"])
        prio = "high" if typ == "Incident" and rnd.random() < 0.7 else rnd.choice(["medium", "low"])
        words = rnd.choices(QUEUES[q], k=4) + (["urgent", "down"] if prio == "high" else ["please", "question"])
        rows.append({"subject": "" if i % 17 == 0 else f"{q} issue {i}", "body": " ".join(words) + f" case {i}",
                     "answer": f"Resolution for {q} {typ}", "type": typ, "queue": q, "priority": prio,
                     "language": "en", "tag_1": QUEUES[q][0], "tag_2": None})
    return pd.DataFrame(rows)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    d = tmp_path_factory.mktemp("raw")
    synth().to_csv(d / "main.csv", index=False)
    de = pd.DataFrame([{"subject": f"Thema {i}", "body": f"Frage zu Thema {i} bitte helfen", "queue": f"Topic{i % 5}/Sub",
                        "priority": rnd, "language": "de"}
                       for i, rnd in zip(range(150), ["critical", "low", "medium"] * 50)])
    de.to_csv(d / "de.csv", index=False)
    man = split.run(d / "main.csv", None, d / "de.csv", use_extra=False)
    emb = embed.run("hash")
    tr = train.train(recall_target=0.8)
    return {"man": man, "emb": emb, "train": tr}


def test_split_is_leak_free_and_deterministic(built):
    ins = pd.read_csv(C.SPLIT_DIR / "test_inputs.csv")
    labs = pd.read_csv(C.SPLIT_DIR / "test_labels.csv")
    kb = pd.read_csv(C.SPLIT_DIR / "kb_train.csv")
    assert list(ins.columns) == ["ticket_id", "subject", "body"]
    assert "answer" not in labs.columns
    assert set(ins.ticket_id).isdisjoint(kb.ticket_id)
    assert built["man"]["rows"]["kb"] == int(0.8 * built["man"]["rows"]["total"])
    assert kb.ticket_id[0] == "TKT-00000" and (C.SPLIT_DIR / "german_kb.csv").exists()
    a_kb, a_te = split.make_split(synth())
    b_kb, b_te = split.make_split(synth())
    assert a_kb.equals(b_kb) and a_te.equals(b_te)   # same seed -> identical split


def test_priority_mapping(built):
    assert set(pd.read_csv(C.SPLIT_DIR / "german_kb.csv").priority) <= {"high", "medium", "low"}


def test_classifier_trained_and_calibrated(built):
    v = built["train"]["val"]
    assert all(v[t]["macro_f1"] > 0.6 for t in ("type", "queue", "priority"))
    clf = Classifier.load(C.MODEL_DIR)
    out = clf.predict("", "server outage vpn down urgent")
    assert out["queue"]["label"] == "Technical Support" and 0 < out["queue"]["confidence"] <= 1
    assert "high_priority_incident" in out


def test_hierarchy_nodes(built):
    from engine.app.retrieval.schema import MISC
    kb, vecs = offline.load_kb()
    df = hierarchy.prepare_chunks(kb)
    nodes = {n["queue"]: n for n in hierarchy.build_queue_nodes(df, vecs)}
    assert {"Technical Support", "Billing and Payments", "Customer Service"} <= set(nodes)
    assert all(abs(float((n["vector"] ** 2).sum()) - 1) < 1e-4 for n in nodes.values())
    assert sum(n["chunk_count"] for n in nodes.values()) == len(kb)
    de = hierarchy.prepare_chunks(pd.read_csv(C.SPLIT_DIR / "german_kb.csv", keep_default_na=False))
    assert (~de["precedent"]).all() and (de["queue_node"] == MISC).all()   # German rows never become precedents


def test_numpy_hierarchical_search_matches_flat_when_confident(built):
    kb, vecs = offline.load_kb()
    nodes = hierarchy.build_queue_nodes(hierarchy.prepare_chunks(kb), vecs)
    names, cent = [n["queue"] for n in nodes], np.stack([n["vector"] for n in nodes])
    q = vecs[:50]
    qp = np.zeros((50, len(names)))
    for i, queue in enumerate(kb["queue"][:50]):
        qp[i, names.index(queue)] = 1.0           # perfect classifier
    idx, sims, fb, routed = offline.hier_search(q, vecs, kb["queue"].to_numpy(dtype=object), cent, names, qp, k=5)
    assert (idx[:, 0] == np.arange(50)).all() and sims[:, 0].min() > 0.99
    assert all(names.index(kb["queue"][i]) in routed[i] for i in range(50))


def test_tuning_and_holdout_eval(built):
    b = tune_blend.run()
    assert 0.0 <= b["best_w"] <= 1.0
    rq = retrieval_quality.run(0.8)
    assert 0 <= rq["min_top1_similarity"]["threshold"] < 1 and rq["hierarchical"]["best_alpha"] in retrieval_quality.ALPHAS
    m = evaluate.run(blend=True)
    assert m["n_test"] > 0 and m["targets"]["queue"]["macro_f1"] > 0.6
    th = json.loads((C.MODEL_DIR / "thresholds.json").read_text())
    assert {"priority_high_threshold", "blend_weight", "retrieval_threshold", "route_alpha"} <= set(th)


def test_language():
    assert detect_language("My VPN is down and nobody in the hospital can reach the system")[0] == "en"
    assert detect_language("Das VPN ist ausgefallen und niemand im Krankenhaus kann arbeiten")[0] == "de"
    assert detect_language("Le serveur est en panne depuis ce matin et personne ne peut travailler")[0] == "other"
    assert detect_language("")[0] == "en"
