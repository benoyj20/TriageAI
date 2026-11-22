"""The object every pipeline stage reads from and writes to."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from engine.app.schemas import SUPPORTED_LANGUAGES


@dataclass
class TicketState:
    """Everything one ticket accumulates on its way through the pipeline.

    A stage is a function ``stage(state) -> None``: it reads what earlier stages wrote and
    fills in its own part. Parts that end up in the response use the contract's JSON shapes
    (plain dicts, see contracts/README.md), so a stage's output can be compared with
    contracts/examples/ directly. pipeline.py validates the assembled response against
    engine.app.schemas, so a wrong shape fails loudly in tests.
    """

    request_id: str
    ticket_id: str
    subject: str  # PII-masked, "" when absent
    body: str  # PII-masked
    created_at: datetime

    # language stage (ML) -> contract "language"
    language: dict[str, Any] | None = None
    # global_search stage (ML): query vector and the unfiltered top-10, used for the
    # classifier's neighbour vote and as the fallback precedents. Never returned.
    query_embedding: list[float] | None = None
    global_neighbours: list[dict[str, Any]] = field(default_factory=list)
    # classify stage (ML) -> contract "classification"
    classification: dict[str, Any] | None = None
    # route_and_search stage (ML) -> contract "retrieval" and "precedents"
    retrieval: dict[str, Any] | None = None
    precedents: list[dict[str, Any]] = field(default_factory=list)
    # ticket_id -> the agent's full answer, for the drafting prompt only. Never returned.
    evidence: dict[str, str] = field(default_factory=dict)
    # draft + validate stages (Hriday) -> contract "draft"
    draft: dict[str, Any] | None = None
    llm_failed: bool = False
    # Things the model says the evidence can't support; the pipeline turns them into an
    # UNSUPPORTED_REQUEST gate reason even when no keyword matched.
    unsupported_requests: list[str] = field(default_factory=list)
    insufficient_evidence: bool = False
    # gate stage (data analyst) -> contract "gate" and "burst"
    gate: dict[str, Any] | None = None
    burst: dict[str, Any] | None = None

    latency_ms: dict[str, float] = field(default_factory=dict)
    warnings: list[dict[str, str]] = field(default_factory=list)

    @property
    def text(self) -> str:
        """Subject and body as one string, the way the classifier and gate read them."""
        return f"{self.subject}\n\n{self.body}" if self.subject else self.body

    @property
    def reply_language(self) -> str:
        """Drafts are written in the detected language, or English when it is not supported."""
        code = (self.language or {}).get("code")
        return code if code in SUPPORTED_LANGUAGES else "en"

    def warn(self, stage: str, code: str, message: str) -> None:
        self.warnings.append({"stage": stage, "code": code, "message": message[:300]})
