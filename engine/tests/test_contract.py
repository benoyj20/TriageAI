"""Contract v1: the examples, the models, the JSON schemas, the gate and the UI agree."""

from __future__ import annotations

import json
import re
from pathlib import Path

import jsonschema
import pytest

from engine.app import contract_export
from engine.app.contract_rules import check_invariants
from engine.app.policy.burst import OutageBurstDetector
from engine.app.policy.gate import P1_CODES, P2_CODES, EscalationGate
from engine.app.schemas import (
    REASON_SEVERITY,
    EngineHealth,
    EngineTriageRequest,
    EngineTriageResponse,
    ErrorResponse,
    GatewayHealth,
    TriageRequest,
    TriageResponse,
)

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"
EXAMPLES = CONTRACTS / "examples"
RESPONSES = sorted(EXAMPLES.glob("triage_response.*.json"))

OTHER_EXAMPLES = {
    "triage_request.json": (TriageRequest, "triage_request.schema.json"),
    "triage_request.no_subject.json": (TriageRequest, "triage_request.schema.json"),
    "error.validation.json": (ErrorResponse, "error.schema.json"),
    "error.engine_unavailable.json": (ErrorResponse, "error.schema.json"),
    "health.json": (GatewayHealth, "health.schema.json"),
    "engine/triage_request.json": (EngineTriageRequest, "engine_triage_request.schema.json"),
    "engine/healthz.json": (EngineHealth, "engine_health.schema.json"),
}


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def schema(name: str) -> jsonschema.Draft202012Validator:
    return jsonschema.Draft202012Validator(load(CONTRACTS / "schema" / name))


def to_engine_response(resp: dict) -> dict:
    """What the engine returns before the gateway adds pii and its own latency."""
    out = {k: v for k, v in resp.items() if k != "pii"}
    latency = dict(out["latency_ms"])
    gateway = latency.pop("gateway")
    latency["total"] = round(latency["total"] - gateway, 1)
    out["latency_ms"] = latency
    return out


@pytest.mark.parametrize("path", RESPONSES, ids=lambda p: p.name)
def test_response_example_matches_models_schema_and_rules(path: Path) -> None:
    data = load(path)
    TriageResponse.model_validate(data)
    schema("triage_response.schema.json").validate(data)
    assert check_invariants(data) == []
    engine = to_engine_response(data)
    EngineTriageResponse.model_validate(engine)
    schema("engine_triage_response.schema.json").validate(engine)


@pytest.mark.parametrize("name", sorted(OTHER_EXAMPLES), ids=str)
def test_other_examples_match_models_and_schema(name: str) -> None:
    model, schema_name = OTHER_EXAMPLES[name]
    data = load(EXAMPLES / name)
    model.model_validate(data)
    schema(schema_name).validate(data)


def test_examples_cover_every_decision_and_draft_mode_the_ui_must_render() -> None:
    examples = [load(p) for p in RESPONSES]
    assert {e["gate"]["decision"] for e in examples} == {"AUTO_DRAFT", "HUMAN_REVIEW", "ESCALATE_ONCALL"}
    assert {"generated", "extractive"} <= {e["draft"]["mode"] for e in examples}
    assert any(e["burst"] for e in examples)
    assert any(e["retrieval"]["route"]["fallback_global"] for e in examples)
    assert {e["language"]["code"] for e in examples} == {"en", "de"}


@pytest.mark.parametrize("path", RESPONSES, ids=lambda p: p.name)
def test_example_gate_output_is_what_the_real_gate_produces(path: Path) -> None:
    resp = load(path)
    cls = resp["classification"]
    detector = OutageBurstDetector(window_seconds=600, burst_threshold=3)
    if resp["burst"]:
        for i in range(resp["burst"]["ticket_count"] - 1):
            detector.record_and_evaluate(f"TKT-PRE-{i}", f"Our VPN is down at site {i}", cls["queue"]["label"])
    result = EscalationGate(burst_detector=detector).evaluate(
        ticket_id=resp["ticket_id"],
        text=f"{resp['subject']}\n\n{resp['body']}" if resp["subject"] else resp["body"],
        detected_language=resp["language"]["code"],
        pred_type=cls["type"]["label"],
        pred_queue=cls["queue"]["label"],
        prob_high_priority=cls["priority"]["p_high"],
        overall_confidence=min(cls["type"]["confidence"], cls["priority"]["confidence"]),
        top_precedent_similarity=resp["retrieval"]["top_similarity"],
        is_ungrounded=resp["draft"]["mode"] == "generated" and not resp["draft"]["validation"]["passed"],
        engine_degraded=resp["draft"]["mode"] == "extractive",
    )
    reasons = [
        {"code": r.value, "severity": REASON_SEVERITY[r.value], "detail": d}
        for r, d in zip(result.reasons, result.explanations)
    ]
    assert result.action.value == resp["gate"]["decision"]
    assert reasons == resp["gate"]["reasons"]
    if resp["burst"]:
        assert result.burst_cluster is not None
        assert result.burst_cluster.cluster_id == resp["burst"]["cluster_id"]
        assert result.burst_cluster.lead_term == resp["burst"]["lead_term"]
        assert result.burst_cluster.ticket_count == resp["burst"]["ticket_count"]


def test_published_json_schemas_are_up_to_date() -> None:
    for name, text in contract_export.render().items():
        path = CONTRACTS / "schema" / name
        assert path.exists(), f"missing {path}; run python -m engine.app.contract_export"
        assert path.read_text(encoding="utf-8") == text, f"{name} is stale; run python -m engine.app.contract_export"


def test_reason_severities_match_the_gate_module() -> None:
    assert {c for c, s in REASON_SEVERITY.items() if s == "P1"} == {c.value for c in P1_CODES}
    assert {c for c, s in REASON_SEVERITY.items() if s == "P2"} == {c.value for c in P2_CODES}


def test_reason_codes_doc_lists_every_code() -> None:
    doc = (CONTRACTS / "reason_codes.md").read_text(encoding="utf-8")
    missing = [code for code in REASON_SEVERITY if f"`{code}`" not in doc]
    assert not missing, f"contracts/reason_codes.md does not document {missing}"


def test_console_reason_table_matches_the_contract() -> None:
    constants = ROOT / "frontend" / "src" / "lib" / "constants.js"
    if not constants.exists():
        pytest.skip("frontend not checked out")
    table = dict(re.findall(r"(\w+): \{ severity: '(P[12])'", constants.read_text(encoding="utf-8")))
    assert table == REASON_SEVERITY
