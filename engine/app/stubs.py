"""Stand-in stages, so the engine answers in contract shape before the real modules land.

Each stub is replaced by its owner's module in pipeline.STAGES:

    language, global_search, classify, route_and_search  -> ML engineer (engine/app/analyze, engine/app/retrieval)
    draft, validate                                      -> Hriday (engine/app/generate)

The gate stage is already real (data analyst, engine/app/policy). /healthz lists which
stages are still stubs. Stub output is deliberately honest: low confidence and no
precedents, so every ticket goes to HUMAN_REVIEW until the real stages are wired.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from engine.app.generate.fallbacks import fallback_draft
from engine.app.contract_rules import CITATION_RE
from engine.app.state import TicketState

StageFn = Callable[[TicketState], None]


def stub(fn: StageFn) -> StageFn:
    fn.is_stub = True  # type: ignore[attr-defined]
    return fn


_DE_WORDS = {"der", "die", "das", "und", "nicht", "ich", "ist", "wir", "bitte", "seit", "mit", "kann", "keine", "für", "eine", "sind", "unsere", "hallo"}
_WORD = re.compile(r"[a-zäöüß]+")


@stub
def detect_language(state: TicketState) -> None:
    words = _WORD.findall(state.text.lower())
    german = sum(w in _DE_WORDS for w in words) + 2 * bool(re.search(r"[äöüß]", state.text.lower()))
    code = "de" if german >= 2 else "en"
    state.language = {"code": code, "confidence": 0.6, "supported": True}


@stub
def global_search(state: TicketState) -> None:
    state.query_embedding = None
    state.global_neighbours = []


@stub
def classify(state: TicketState) -> None:
    """A flat prior: confident about nothing, so the gate adds LOW_CONFIDENCE."""
    state.classification = {
        "type": {"label": "Request", "confidence": 0.4, "probs": {"Request": 0.4, "Incident": 0.3, "Problem": 0.2, "Change": 0.1}},
        "queue": {
            "label": "General Inquiry",
            "confidence": 0.3,
            "probs": {"General Inquiry": 0.3, "Technical Support": 0.25, "Customer Service": 0.2, "IT Support": 0.15, "Product Support": 0.1},
            "votes": 0,
            "k": 0,
        },
        "priority": {"label": "medium", "confidence": 0.4, "probs": {"high": 0.25, "medium": 0.4, "low": 0.35}, "p_high": 0.25},
    }


@stub
def route_and_search(state: TicketState) -> None:
    """No index yet: score the queues from the classifier, search nothing."""
    probs = (state.classification or {}).get("queue", {}).get("probs", {})
    top = sorted(probs.items(), key=lambda kv: kv[1], reverse=True)[:3]
    state.retrieval = {
        "route": {"queues": [{"queue": q, "score": p} for q, p in top], "searched": [], "fallback_global": True},
        "top_similarity": 0.0,
        "k": 5,
    }
    state.precedents = []
    state.evidence = {}


@stub
def draft(state: TicketState) -> None:
    """No LLM yet: extractive reply from the best precedent, or the holding reply."""
    state.draft = fallback_draft(state.reply_language, state.precedents, state.evidence)
    if state.draft["mode"] == "extractive":
        state.llm_failed = True
        state.warn("draft", "LLM_NOT_WIRED", "Draft generation is still a stub; extractive fallback used.")


@stub
def validate(state: TicketState) -> None:
    """Checks citations only. Numbers and language are checked by the real validator (H-11)."""
    d = state.draft or {}
    known = {p["ticket_id"] for p in state.precedents}
    cited = list(dict.fromkeys(CITATION_RE.findall(d.get("text", ""))))
    issues: list[str] = []
    unknown = [c for c in cited if c not in known]
    if unknown:
        issues.append(f"Cites tickets that are not precedents: {', '.join(unknown)}")
    if d.get("mode") in ("generated", "extractive") and not cited:
        issues.append("A grounded reply must cite at least one precedent.")
    if d.get("mode") == "generated":
        issues.append("Numbers and reply language are not checked yet (stub validator).")
    citations_ok = not unknown and not (d.get("mode") in ("generated", "extractive") and not cited)
    d["citations"] = cited
    d["validation"] = {
        "passed": citations_ok,
        "citations_ok": citations_ok,
        "numbers_ok": True,
        "language_ok": True,
        "retries": 0,
        "issues": issues,
    }
    state.draft = d
