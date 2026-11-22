"""Burst detection: only new live tickets close together in time, never demo traffic or duplicates."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from engine.app import pipeline
from engine.app.main import app
from engine.app.policy.burst import OutageBurstDetector

VPN = [
    "VPN down at the Berlin office, nobody can connect.",
    "Our VPN is not reachable since this morning.",
    "Cannot connect to the VPN, connection times out.",
    "VPN gateway refuses all sessions for remote staff.",
]


@pytest.fixture(autouse=True)
def fresh_gates():
    pipeline.reset_gate()
    yield
    pipeline.reset_gate()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def send(client: TestClient, body: str, ticket_id: str | None = None) -> dict:
    payload = {"body": body} | ({"ticket_id": ticket_id} if ticket_id else {})
    r = client.post("/v1/triage", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def codes(d: dict) -> set[str]:
    return {r["code"] for r in d["gate"]["reasons"]}


def test_one_real_ticket_after_a_simulated_outage_is_not_a_burst(client):
    for i, body in enumerate(VPN):
        send(client, body, ticket_id=f"SIM-RUN1-{i}")  # the console's "Simulate outage" button
    d = send(client, "VPN is breaking very badly, VPN services are down man")
    assert d["burst"] is None and "ACTIVE_OUTAGE" not in codes(d)


def test_the_simulation_itself_still_shows_a_burst(client):
    results = [send(client, body, ticket_id=f"SIM-RUN2-{i}") for i, body in enumerate(VPN)]
    assert results[2]["burst"] is not None and "ACTIVE_OUTAGE" in codes(results[2])


def test_three_distinct_real_tickets_raise_a_burst(client):
    results = [send(client, body) for body in VPN[:3]]
    assert results[0]["burst"] is None and results[1]["burst"] is None
    assert results[2]["burst"]["ticket_count"] == 3 and "ACTIVE_OUTAGE" in codes(results[2])


def test_resending_the_same_ticket_does_not_build_a_burst(client):
    results = [send(client, "VPN is down, please help") for _ in range(4)]
    assert all(r["burst"] is None for r in results)


def test_live_triage_test_tickets_never_count_toward_real_bursts(client):
    for i, body in enumerate(VPN[:2]):
        send(client, body, ticket_id=f"TEST-LAB{i}")
    d = send(client, VPN[2])
    assert d["burst"] is None


def test_warmup_tickets_never_count_toward_real_bursts(client):
    for i, body in enumerate(VPN[:2]):
        send(client, body, ticket_id=f"WARMUP-1-{i}")
    d = send(client, VPN[2])
    assert d["burst"] is None


def test_tickets_outside_the_window_have_aged_out():
    det = OutageBurstDetector(window_seconds=300, burst_threshold=3)
    assert det.record_and_evaluate("A", VPN[0], "IT Support", now=1000.0) is None
    assert det.record_and_evaluate("B", VPN[1], "IT Support", now=1100.0) is None
    # 350 s after the first: A has aged out (window 300 s), so only B and C are in the window.
    assert det.record_and_evaluate("C", VPN[2], "IT Support", now=1350.0) is None
    cluster = det.record_and_evaluate("D", VPN[3], "Technical Support", now=1380.0)
    assert cluster is not None and cluster.ticket_ids == ["B", "C", "D"]


def test_burst_window_and_threshold_come_from_the_environment(monkeypatch):
    monkeypatch.setenv("BURST_WINDOW_S", "120")
    monkeypatch.setenv("BURST_MIN_TICKETS", "5")
    det = pipeline._burst_detector()
    assert (det.window_seconds, det.burst_threshold) == (120, 5)
