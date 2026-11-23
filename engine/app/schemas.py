"""TriageAI API contract v1 as Pydantic models.

This module is the executable form of ``contracts/``:

* every JSON file in ``contracts/examples/`` must validate against these models
  (``engine/tests/test_contract.py`` checks it);
* ``contracts/schema/*.json`` is generated from them with
  ``python -m engine.app.contract_export``.

Change a field only together with ``contracts/README.md``, a regenerated schema,
and a message to the team. Additive changes bump the minor version (1.1);
renames and removals bump the major version (2.0).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

CONTRACT_VERSION = "1.0"

KB_TICKET_ID = r"^TKT-\d{5}$"
CLIENT_TICKET_ID = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$"
LANGUAGE_CODE = r"^([a-z]{2}|unknown)$"

BODY_MAX_CHARS = 10_000
SUBJECT_MAX_CHARS = 500
# PII placeholders can make the masked text a little longer than what the user typed.
MASKED_BODY_MAX_CHARS = 12_000

TicketType = Literal["Incident", "Request", "Problem", "Change"]
Priority = Literal["high", "medium", "low"]
Decision = Literal["ESCALATE_ONCALL", "HUMAN_REVIEW", "AUTO_DRAFT"]
Severity = Literal["P1", "P2"]
ReasonCode = Literal[
    "HIGH_PRIORITY_INCIDENT",
    "SECURITY_INCIDENT",
    "ACTIVE_OUTAGE",
    "LEGAL_OR_COMPLIANCE",
    "PROMPT_INJECTION",
    "NO_PRECEDENT",
    "LOW_CONFIDENCE",
    "UNSUPPORTED_REQUEST",
    "UNGROUNDED_DRAFT",
    "UNSUPPORTED_LANGUAGE",
    "ENGINE_DEGRADED",
]
DraftMode = Literal["generated", "extractive", "holding"]
ReplyLanguage = Literal["en", "de"]
PiiType = Literal["EMAIL", "PHONE", "IP", "IBAN", "CARD", "ACCOUNT"]
ErrorCode = Literal[
    "INVALID_JSON",
    "VALIDATION_ERROR",
    "PAYLOAD_TOO_LARGE",
    "RATE_LIMITED",
    "ENGINE_UNAVAILABLE",
    "ENGINE_TIMEOUT",
    "ENGINE_BAD_RESPONSE",
    "INTERNAL",
    "NOT_FOUND",
]
HealthStatus = Literal["ok", "degraded", "down"]
ComponentStatus = Literal["ok", "down", "stub", "unknown"]

Probability = Annotated[float, Field(ge=0.0, le=1.0)]
Cosine = Annotated[float, Field(ge=-1.0, le=1.0)]
Millis = Annotated[float, Field(ge=0.0)]
KbTicketId = Annotated[str, Field(pattern=KB_TICKET_ID)]

REASON_SEVERITY: dict[str, str] = {
    "HIGH_PRIORITY_INCIDENT": "P1",
    "SECURITY_INCIDENT": "P1",
    "ACTIVE_OUTAGE": "P1",
    "LEGAL_OR_COMPLIANCE": "P2",
    "PROMPT_INJECTION": "P2",
    "NO_PRECEDENT": "P2",
    "LOW_CONFIDENCE": "P2",
    "UNSUPPORTED_REQUEST": "P2",
    "UNGROUNDED_DRAFT": "P2",
    "UNSUPPORTED_LANGUAGE": "P2",
    "ENGINE_DEGRADED": "P2",
}
SUPPORTED_LANGUAGES = ("en", "de")


class _Response(BaseModel):
    """Responses never carry undocumented fields."""

    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- requests


class TriageRequest(BaseModel):
    """POST /api/v1/triage body (console -> Go gateway). Unknown fields are ignored."""

    model_config = ConfigDict(extra="ignore")

    subject: str | None = Field(default=None, max_length=SUBJECT_MAX_CHARS)
    body: str = Field(min_length=1, max_length=BODY_MAX_CHARS)
    ticket_id: str | None = Field(
        default=None,
        pattern=CLIENT_TICKET_ID,
        description="Optional client id. The gateway assigns LIVE-XXXXXXXX when it is absent.",
    )

    @field_validator("body")
    @classmethod
    def _body_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be only whitespace")
        return v


class EngineTriageRequest(BaseModel):
    """POST /v1/triage body (Go gateway -> Python engine). Text is already PII-masked.

    The gateway always sends request_id, ticket_id and created_at. The defaults exist
    only so teammates can call the engine directly while developing.
    """

    model_config = ConfigDict(extra="forbid")

    request_id: str | None = Field(default=None, max_length=64)
    ticket_id: str | None = Field(default=None, pattern=CLIENT_TICKET_ID)
    subject: str = Field(default="", max_length=SUBJECT_MAX_CHARS + 200)
    body: str = Field(min_length=1, max_length=MASKED_BODY_MAX_CHARS)
    created_at: AwareDatetime | None = None

    @field_validator("body")
    @classmethod
    def _body_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be only whitespace")
        return v


# --------------------------------------------------------------------------- response parts


class Language(_Response):
    code: str = Field(pattern=LANGUAGE_CODE)
    confidence: Probability
    supported: bool = Field(description="True only for en and de.")


class PiiCount(_Response):
    type: PiiType
    count: int = Field(ge=1)


class Pii(_Response):
    masked: list[PiiCount]


class TypeHead(_Response):
    label: TicketType
    confidence: Probability = Field(description="Calibrated probability of label; equals probs[label].")
    probs: dict[str, Probability] = Field(description="All four types.")


class QueueHead(_Response):
    label: str
    confidence: Probability
    probs: dict[str, Probability] = Field(description="Top 5 queues.")
    votes: int = Field(ge=0, description="Neighbours among the global top-k that share label.")
    k: int = Field(ge=0, description="Neighbours that voted.")


class PriorityHead(_Response):
    label: Priority
    confidence: Probability
    probs: dict[str, Probability] = Field(description="high, medium and low.")
    p_high: Probability = Field(description="Calibrated P(high); the gate compares it to the recall-tuned threshold.")


class Classification(_Response):
    type: TypeHead
    queue: QueueHead
    priority: PriorityHead


class QueueScore(_Response):
    queue: str
    score: Probability


class Route(_Response):
    queues: list[QueueScore] = Field(description="Level-1 queue scores, best first (top 3).")
    searched: list[str] = Field(description="Queues the level-2 search ran in.")
    fallback_global: bool = Field(description="True when the precedents come from the global search instead.")


class Retrieval(_Response):
    route: Route
    top_similarity: Cosine = Field(description="Similarity of precedents[0]; 0 when there are none.")
    k: int = Field(ge=1, le=20, description="Maximum number of precedents returned.")


class Precedent(_Response):
    ticket_id: KbTicketId
    similarity: Cosine
    language: str = Field(pattern=LANGUAGE_CODE)
    type: TicketType
    queue: str
    priority: Priority
    subject: str
    answer_snippet: str = Field(max_length=400, description="First ~300 characters of the agent's answer.")
    tags: list[str] = Field(default_factory=list)


class GateReason(_Response):
    code: ReasonCode
    severity: Severity
    detail: str


class Gate(_Response):
    decision: Decision
    reasons: list[GateReason]


class Validation(_Response):
    passed: bool = Field(description="citations_ok and numbers_ok and language_ok.")
    citations_ok: bool
    numbers_ok: bool
    language_ok: bool
    retries: int = Field(ge=0, le=2)
    issues: list[str]


class Draft(_Response):
    language: ReplyLanguage
    text: str
    citations: list[KbTicketId] = Field(description="Every [TKT-xxxxx] in text, in order of first use.")
    mode: DraftMode
    validation: Validation


class Burst(_Response):
    cluster_id: str
    queue: str
    lead_term: str
    ticket_count: int = Field(ge=1)
    first_seen: AwareDatetime
    last_seen: AwareDatetime


class EngineLatency(_Response):
    # The JSON key is "validate"; the Python name differs because BaseModel.validate exists.
    model_config = ConfigDict(extra="forbid", validate_by_name=True, validate_by_alias=True, serialize_by_alias=True)

    language: Millis
    classify: Millis
    retrieve: Millis = Field(description="Query embedding + global search + routing + level-2 search.")
    gate: Millis = Field(description="Gate rules + burst detection.")
    draft: Millis
    validate_: Millis = Field(alias="validate")
    total: Millis = Field(description="Wall time; at least the sum of the stages.")


class GatewayLatency(EngineLatency):
    gateway: Millis = Field(description="Gateway's own time: validation, PII masking, IDs.")


class StageWarning(_Response):
    stage: str
    code: str
    message: str


class EngineTriageResponse(_Response):
    """Engine -> gateway. Same as TriageResponse without pii and latency_ms.gateway."""

    contract_version: Literal["1.0"]
    request_id: str
    ticket_id: str
    subject: str = Field(description="PII-masked; empty string when there was no subject.")
    body: str = Field(description="PII-masked.")
    created_at: AwareDatetime
    processed_at: AwareDatetime
    language: Language
    classification: Classification
    retrieval: Retrieval
    precedents: list[Precedent] = Field(description="Best first. Can be empty (NO_PRECEDENT).")
    gate: Gate
    draft: Draft
    burst: Burst | None
    latency_ms: EngineLatency
    warnings: list[StageWarning] = Field(default_factory=list)


class TriageResponse(EngineTriageResponse):
    """Gateway -> console. The gateway adds pii and latency_ms.gateway and recomputes total."""

    pii: Pii
    latency_ms: GatewayLatency


# --------------------------------------------------------------------------- errors and health


class ErrorBody(_Response):
    code: ErrorCode
    message: str
    request_id: str | None = None


class ErrorResponse(_Response):
    error: ErrorBody


class GatewayHealth(_Response):
    """GET /api/v1/health"""

    status: HealthStatus
    mode: Literal["live", "mock"]
    contract_version: str
    components: dict[str, ComponentStatus] = Field(description="gateway, engine, vector_db.")


class EngineHealth(_Response):
    """GET /healthz on the engine"""

    status: HealthStatus
    contract_version: str
    stages: dict[str, Literal["real", "stub"]]
    components: dict[str, ComponentStatus] = Field(description="vector_db, llm, artifacts.")


def utc_iso(dt: datetime) -> str:
    """Render a datetime the way the contract examples do (UTC, trailing Z)."""
    return dt.isoformat().replace("+00:00", "Z")
