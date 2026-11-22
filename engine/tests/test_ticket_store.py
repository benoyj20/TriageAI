"""Shared ticket store: creators submit, managers list and resolve. Redis is faked in memory."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from engine.app import pipeline
from engine.app.common import chunk_stats, ticket_store
from engine.app.main import app


class FakeRedis:
    def __init__(self):
        self.kv, self.z, self.h = {}, {}, {}

    def set(self, key, value, ex=None, nx=False):
        if nx and key in self.kv:
            return None
        self.kv[key] = value.encode() if isinstance(value, str) else value
        return True

    def get(self, key):
        return self.kv.get(key)

    def hset(self, key, mapping):
        self.h.setdefault(key, {}).update({k: v.encode() for k, v in mapping.items()})

    def hmget(self, key, fields):
        return [self.h.get(key, {}).get(f) for f in fields]

    def zadd(self, key, mapping):
        self.z.setdefault(key, {}).update(mapping)

    def zrevrange(self, key, start, end):
        ids = sorted(self.z.get(key, {}), key=lambda k: self.z[key][k], reverse=True)
        return [i.encode() for i in ids[start : end + 1]]

    def zremrangebyrank(self, *a):
        return 0

    def zremrangebyscore(self, *a):
        return 0

    def pipeline(self, transaction=False):
        redis, ops = self, []

        class Pipe:
            def __getattr__(self, name):
                return lambda *a, **k: ops.append((name, a, k))

            def execute(self):
                return [getattr(redis, n)(*a, **k) for n, a, k in ops]

        return Pipe()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://fake")
    from engine.app import settings

    settings.get_settings.cache_clear()
    chunk_stats.set_redis(FakeRedis())
    pipeline.reset_gate()
    yield TestClient(app, raise_server_exceptions=False)
    chunk_stats.set_redis(None)
    pipeline.reset_gate()


def triage(client, body, ticket_id=None):
    payload = {"body": body} | ({"ticket_id": ticket_id} if ticket_id else {})
    r = client.post("/v1/triage", json=payload)
    assert r.status_code == 200
    return r.json()


def test_submitted_tickets_reach_the_manager_list_newest_first(client):
    a = triage(client, "My invoice shows the wrong VAT rate.")
    b = triage(client, "Ransomware encrypted our file server.")
    items = client.get("/v1/tickets").json()["items"]
    assert [i["ticket_id"] for i in items] == [b["ticket_id"], a["ticket_id"]]
    assert items[0]["status"] == "escalated" and items[1]["status"] == "review"
    assert items[0]["gate"]["decision"] == "ESCALATE_ONCALL"


def test_creator_status_view_reveals_nothing_internal(client):
    t = triage(client, "Ransomware encrypted our file server.")
    view = client.get(f"/v1/tickets/{t['ticket_id']}/status").json()
    assert set(view) == {"ticket_id", "subject", "created_at", "status", "updated_at"}
    assert view["status"] == "escalated"


def test_manager_can_move_a_ticket_and_the_creator_sees_it(client):
    t = triage(client, "Printer offline again.")
    r = client.put(f"/v1/tickets/{t['ticket_id']}/status", json={"status": "resolved"})
    assert r.status_code == 200 and r.json()["status"] == "resolved"
    assert client.get(f"/v1/tickets/{t['ticket_id']}/status").json()["status"] == "resolved"
    assert client.put(f"/v1/tickets/{t['ticket_id']}/status", json={"status": "bogus"}).status_code == 422
    assert client.get("/v1/tickets/LIVE-NOPE/status").status_code == 404


def test_warmup_tickets_are_not_stored(client):
    triage(client, "VPN down", ticket_id="WARMUP-1-0")
    assert client.get("/v1/tickets").json()["items"] == []


def test_store_without_redis_answers_503():
    chunk_stats.set_redis(None)
    c = TestClient(app, raise_server_exceptions=False)
    assert c.get("/v1/tickets").status_code == 503


def test_creator_ticket_view_shows_their_words_and_status_only(client):
    t = triage(client, "Printer offline again since Monday.")
    view = client.get(f"/v1/tickets/{t['ticket_id']}").json()
    assert set(view) == {"ticket_id", "subject", "body", "language", "created_at", "status", "updated_at"}
    assert view["body"] == t["body"] and view["language"] == "en" and view["updated_at"] == view["created_at"]
    client.put(f"/v1/tickets/{t['ticket_id']}/status", json={"status": "resolved"})
    after = client.get(f"/v1/tickets/{t['ticket_id']}").json()
    assert after["status"] == "resolved" and after["updated_at"] >= after["created_at"]
    assert client.get("/v1/tickets/LIVE-NOPE").status_code == 404
