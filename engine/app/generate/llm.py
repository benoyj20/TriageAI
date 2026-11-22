"""The draft and validate pipeline stages (tasks H-09, H-11, H-12).

draft:     no precedents -> holding reply (no LLM call). Otherwise ask Gemini for a grounded
           reply. If the LLM times out or errors -> extractive fallback + ENGINE_DEGRADED.
validate:  check citations, numbers and language. On failure retry once, feeding the
           checker's issues back to the model. Still failing -> the draft keeps
           validation.passed = false and the gate adds UNGROUNDED_DRAFT.
"""

from __future__ import annotations

import logging

from engine.app.common.errors import LLMError as GeminiError  # any provider's failure
from engine.app.common.providers import generate_json
from engine.app.generate.fallbacks import fallback_draft
from engine.app.generate.prompt import DraftOut, build_prompt
from engine.app.generate.validator import Check, citations_in, validate_reply
from engine.app.state import TicketState

log = logging.getLogger("sentineldesk.generate")


def _ask(state: TicketState, feedback: list[str] | None = None) -> DraftOut:
    prompt = build_prompt(
        subject=state.subject,
        body=state.body,
        language=state.reply_language,
        precedents=state.precedents,
        answers=state.evidence,
        feedback=feedback,
    )
    return DraftOut.model_validate(generate_json(prompt, DraftOut))


def _apply(state: TicketState, out: DraftOut) -> None:
    text = out.reply.strip()
    state.draft = {"language": state.reply_language, "text": text, "citations": citations_in(text), "mode": "generated"}
    state.insufficient_evidence = out.insufficient_evidence
    state.unsupported_requests = [u.strip() for u in out.unsupported_requests if u.strip()][:5]


def _degrade(state: TicketState, exc: Exception) -> None:
    log.warning("LLM draft failed (request_id=%s): %s: %s", state.request_id, type(exc).__name__, exc)
    state.llm_failed = True
    state.warn("draft", "LLM_FAILED", f"{type(exc).__name__}: {exc}")
    state.draft = fallback_draft(state.reply_language, state.precedents, state.evidence)


def draft_stage(state: TicketState) -> None:
    if not state.precedents:
        state.draft = fallback_draft(state.reply_language, [], {})
        return
    try:
        _apply(state, _ask(state))
    except (GeminiError, ValueError) as exc:  # ValueError covers pydantic ValidationError
        _degrade(state, exc)


def _check(state: TicketState) -> Check:
    return validate_reply(
        state.draft["text"],
        language=state.reply_language,
        precedents=state.precedents,
        answers=state.evidence,
        ticket_text=state.text,
    )


def _record(state: TicketState, check: Check, retries: int) -> None:
    state.draft["citations"] = check.citations
    state.draft["validation"] = {
        "passed": check.passed,
        "citations_ok": check.citations_ok,
        "numbers_ok": check.numbers_ok,
        "language_ok": check.language_ok,
        "retries": retries,
        "issues": check.issues,
    }


def validate_stage(state: TicketState) -> None:
    d = state.draft or fallback_draft(state.reply_language, state.precedents, state.evidence)
    state.draft = d
    check = _check(state)
    retries = 0
    if d["mode"] == "generated" and not check.passed:
        try:
            _apply(state, _ask(state, feedback=check.issues))
            retries = 1
            check = _check(state)
        except (GeminiError, ValueError) as exc:
            log.warning("validation retry failed (request_id=%s): %s", state.request_id, exc)
            state.warn("validate", "RETRY_FAILED", f"{type(exc).__name__}: {exc}")
    _record(state, check, retries)
