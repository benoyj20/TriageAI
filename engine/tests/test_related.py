"""Related readings for ticket creators: past solved tickets, translated into the creator's language.

The LLM is faked here (unit tests); the live flow is checked against the deployed stack.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from engine.app import pipeline, related
from engine.app.common import chunk_stats
from engine.app.main import app
from engine.tests.test_ticket_store import FakeRedis

DE_ANSWER = (
    "Bitte starten Sie den VPN-Client neu und melden Sie sich erneut an. Wenn das Problem weiterhin besteht, "
    "kontaktieren Sie <name> unter <tel_num>, und wir prüfen die Verbindung."
)
EN_ANSWER = (
    "Please restart the VPN client and sign in again. If the problem continues, contact <name> at <tel_num> "
    "and we will check the connection."
)


@pytest.fixture
def redis(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://fake")
    from engine.app import settings

    settings.get_settings.cache_clear()
    fake = FakeRedis()
    chunk_stats.set_redis(fake)
    pipeline.reset_gate(precedent_similarity_threshold=0.35)
    yield fake
    chunk_stats.set_redis(None)
    pipeline.reset_gate()


@pytest.fixture
def client(redis) -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def store(redis, tid="LIVE-ABC12345", lang="en", precedents=None):
    doc = {
        "ticket_id": tid,
        "subject": "VPN broken",
        "body": "The VPN drops every few minutes.",
        "created_at": "2026-11-21T19:00:00Z",
        "language": {"code": lang, "confidence": 0.99, "supported": True},
        "draft": {"language": lang},
        "precedents": precedents
        if precedents is not None
        else [
            {"ticket_id": "TKT-00001", "similarity": 0.71, "language": "de", "subject": "VPN trennt", "answer_snippet": "Bitte..."},
            {"ticket_id": "TKT-00002", "similarity": 0.20, "language": "en", "subject": "Unrelated", "answer_snippet": "Nope."},
        ],
    }
    redis.set(f"live:ticket:{tid}", json.dumps(doc))
    redis.hset("chunk:TKT-00001", {"subject": "VPN trennt sich ständig", "body": "Unser VPN bricht alle paar Minuten ab.", "answer": DE_ANSWER, "language": "de"})
    return tid


def fake_llm(monkeypatch, answer=EN_ANSWER, calls=None):
    def gen(prompt, schema, **kw):
        if calls is not None:
            calls.append(prompt)
        return {"items": [{"ref": "TKT-00001", "subject": "VPN keeps disconnecting", "problem": "Our VPN drops every few minutes.", "answer": answer}]}

    monkeypatch.setattr(related, "generate_json", gen)


def test_a_german_precedent_is_translated_for_an_english_ticket(client, redis, monkeypatch):
    calls = []
    fake_llm(monkeypatch, calls=calls)
    out = client.get(f"/v1/tickets/{store(redis)}/related").json()
    assert out["language"] == "en" and "complete" not in out
    assert [i["ref"] for i in out["items"]] == ["TKT-00001"]  # the 0.20 precedent is below the grounding floor
    item = out["items"][0]
    assert item["translated"] and item["original_language"] == "de" and item["language"] == "en"
    assert item["answer"] == EN_ANSWER and "German" not in calls[0] and "English" in calls[0]
    client.get("/v1/tickets/LIVE-ABC12345/related")
    assert len(calls) == 1  # cached: a ticket costs at most one translation


def test_a_translation_that_drops_a_placeholder_is_not_shown(client, redis, monkeypatch):
    fake_llm(monkeypatch, answer=EN_ANSWER.replace("<tel_num>", "555-0100"))
    item = client.get(f"/v1/tickets/{store(redis)}/related").json()["items"][0]
    assert not item["translated"] and item["language"] == "de" and item["answer"] == DE_ANSWER


def test_a_translation_still_in_the_wrong_language_is_not_shown(client, redis, monkeypatch):
    fake_llm(monkeypatch, answer=DE_ANSWER)
    item = client.get(f"/v1/tickets/{store(redis)}/related").json()["items"][0]
    assert not item["translated"] and item["original_language"] == "de"


def test_llm_failure_returns_the_originals_and_retries_later(client, redis, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("provider down")

    monkeypatch.setattr(related, "generate_json", boom)
    out = client.get(f"/v1/tickets/{store(redis)}/related").json()
    assert out["items"][0]["answer"] == DE_ANSWER and not out["items"][0]["translated"]
    cached = json.loads(redis.get("live:related:LIVE-ABC12345:en"))
    assert cached["complete"] is False


def test_same_language_readings_need_no_llm_call(client, redis, monkeypatch):
    calls = []
    fake_llm(monkeypatch, calls=calls)
    tid = store(redis, lang="de")
    item = client.get(f"/v1/tickets/{tid}/related").json()["items"][0]
    assert calls == [] and item["answer"] == DE_ANSWER and not item["translated"] and item["language"] == "de"


def test_no_close_precedent_means_no_readings(client, redis, monkeypatch):
    fake_llm(monkeypatch)
    tid = store(redis, precedents=[{"ticket_id": "TKT-00009", "similarity": 0.1, "language": "en", "subject": "x", "answer_snippet": "y"}])
    assert client.get(f"/v1/tickets/{tid}/related").json()["items"] == []


def test_unknown_ticket_is_404(client):
    assert client.get("/v1/tickets/LIVE-NOPE/related").status_code == 404


def test_triage_prefetches_readings_for_customer_tickets_only(client, monkeypatch):
    seen = []
    monkeypatch.setattr(related, "prefetch", seen.append)
    client.post("/v1/triage", json={"body": "VPN down again", "ticket_id": "LIVE-PREF1"})
    client.post("/v1/triage", json={"body": "VPN down again", "ticket_id": "TEST-PREF2"})
    assert seen == ["LIVE-PREF1"]


def test_literal_newlines_in_knowledge_base_text_are_cleaned():
    assert related._clip("Sehr geehrte/r [Name],\n\nich helfe gern.", 100) == "Sehr geehrte/r [Name], ich helfe gern."
    assert related._clip("word " * 50, 20).endswith("…") and len(related._clip("word " * 50, 20)) <= 20
