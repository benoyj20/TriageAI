"""The engine over HTTP, with the stub stages and the data analyst's real gate."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine.app import pipeline, stubs
from engine.app.contract_rules import check_invariants
from engine.app.main import app
from engine.app.schemas import EngineHealth, EngineTriageResponse, ErrorResponse

EXAMPLES = Path(__file__).resolve().parents[2] / "contracts" / "examples"


@pytest.fixture(autouse=True)
def fresh_gate():
    pipeline.reset_gate()
    yield
    pipeline.reset_gate()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def triage(client: TestClient, **body) -> dict:
    r = client.post("/v1/triage", json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    EngineTriageResponse.model_validate(data)
    assert check_invariants(data) == []
    return data


def codes(data: dict) -> set[str]:
    return {r["code"] for r in data["gate"]["reasons"]}


def with_stage(name: str, fn) -> tuple:
    return tuple(replace(st, run=fn) if st.name == name else st for st in pipeline.STAGES)


def test_healthz_reports_which_stages_are_still_stubs(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    health = EngineHealth.model_validate(r.json())
    assert health.stages["gate"] == "real"
    assert health.stages["classify"] == "stub"
    assert health.status == "degraded"


def test_contract_example_request_gets_a_contract_shaped_answer(client: TestClient) -> None:
    req = json.loads((EXAMPLES / "engine" / "triage_request.json").read_text(encoding="utf-8"))
    data = triage(client, **req)
    assert (data["request_id"], data["ticket_id"]) == (req["request_id"], req["ticket_id"])
    assert data["created_at"].startswith("2026-11-21T14:02:11")
    # Stubs are honest: low confidence, no precedents, so a human reviews it with a holding reply.
    assert data["gate"]["decision"] == "HUMAN_REVIEW"
    assert {"LOW_CONFIDENCE", "NO_PRECEDENT"} <= codes(data)
    assert data["draft"]["mode"] == "holding"
    assert any(w["code"] == "STUB_STAGES" for w in data["warnings"])


def test_engine_fills_ids_when_called_directly(client: TestClient) -> None:
    data = triage(client, body="My invoice shows the wrong VAT rate.")
    assert data["request_id"].startswith("req_")
    assert data["ticket_id"].startswith("LIVE-")
    assert data["subject"] == ""


def test_german_ticket_gets_a_german_reply(client: TestClient) -> None:
    data = triage(client, subject="Rechnung falsch", body="Bitte prüfen Sie unsere Rechnung, die Mehrwertsteuer ist nicht korrekt.")
    assert data["language"]["code"] == "de"
    assert data["draft"]["language"] == "de"
    assert data["draft"]["text"].startswith("Guten Tag,")


def test_security_terms_escalate_to_on_call(client: TestClient) -> None:
    data = triage(client, body="We were hit by ransomware this morning and the file server is encrypted.")
    assert data["gate"]["decision"] == "ESCALATE_ONCALL"
    assert "SECURITY_INCIDENT" in codes(data)


def test_third_similar_ticket_raises_the_outage_burst(client: TestClient) -> None:
    first = triage(client, body="Our VPN is down in Berlin.")
    second = triage(client, body="VPN not connecting from Hamburg office.")
    third = triage(client, body="Nobody can reach the VPN since 8am.")
    assert first["burst"] is None and second["burst"] is None
    assert third["burst"]["ticket_count"] == 3
    assert third["gate"]["decision"] == "ESCALATE_ONCALL"
    assert "ACTIVE_OUTAGE" in codes(third)


def test_a_failing_stage_degrades_the_answer_instead_of_failing_it(client: TestClient, monkeypatch) -> None:
    def index_offline(state):
        raise RuntimeError("index offline")

    monkeypatch.setattr(pipeline, "STAGES", with_stage("route_and_search", index_offline))
    data = triage(client, body="Printer in room 4 is offline again.")
    assert {"stage": "route_and_search", "code": "STAGE_FAILED", "message": "RuntimeError: index offline"} in data["warnings"]
    assert data["precedents"] == []
    assert "NO_PRECEDENT" in codes(data)


def test_a_failing_draft_stage_is_reported_as_engine_degraded(client: TestClient, monkeypatch) -> None:
    def llm_down(state):
        raise TimeoutError("Gemini did not answer")

    monkeypatch.setattr(pipeline, "STAGES", with_stage("draft", llm_down))
    data = triage(client, body="How do I export my data to CSV?")
    assert "ENGINE_DEGRADED" in codes(data)
    assert data["draft"]["mode"] == "holding"  # no precedents to quote yet


def test_a_stage_that_breaks_the_contract_gets_a_500_error_envelope(client: TestClient, monkeypatch) -> None:
    def bad_classify(state):
        stubs.classify(state)
        state.classification["type"]["label"] = "Bug"

    monkeypatch.setattr(pipeline, "STAGES", with_stage("classify", bad_classify))
    r = client.post("/v1/triage", json={"body": "Something odd happened."})
    assert r.status_code == 500
    err = ErrorResponse.model_validate(r.json()).error
    assert err.code == "INTERNAL"
    assert "classification.type.label" in err.message


@pytest.mark.parametrize(
    ("kwargs", "status", "code"),
    [
        ({"json": {"subject": "hi"}}, 422, "VALIDATION_ERROR"),
        ({"json": {"body": "   "}}, 422, "VALIDATION_ERROR"),
        ({"json": {"body": "x" * 12_001}}, 422, "VALIDATION_ERROR"),
        ({"json": {"body": "ok", "surprise": 1}}, 422, "VALIDATION_ERROR"),
        ({"content": b"{not json", "headers": {"content-type": "application/json"}}, 400, "INVALID_JSON"),
    ],
    ids=["missing body", "blank body", "too long", "unknown field", "bad json"],
)
def test_bad_requests_use_the_error_envelope(client: TestClient, kwargs: dict, status: int, code: str) -> None:
    r = client.post("/v1/triage", **kwargs)
    assert r.status_code == status
    assert ErrorResponse.model_validate(r.json()).error.code == code


def test_validation_message_names_the_field(client: TestClient) -> None:
    r = client.post("/v1/triage", json={"subject": "no body"})
    assert r.json()["error"]["message"].startswith("body: ")
