"""Cross-field rules of contract v1 that a JSON schema cannot express.

``check_invariants`` returns a list of human-readable problems (empty when the response
is consistent). The contract tests run it on every example and on live engine output,
so a stage that breaks a rule shows up as a failing test, not as a confusing UI.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from engine.app.schemas import REASON_SEVERITY, SUPPORTED_LANGUAGES

CITATION_RE = re.compile(r"\[(TKT-\d{5})\]")
_STAGE_KEYS = ("language", "classify", "retrieve", "gate", "draft", "validate")


def decision_for(severities: list[str]) -> str:
    if "P1" in severities:
        return "ESCALATE_ONCALL"
    if severities:
        return "HUMAN_REVIEW"
    return "AUTO_DRAFT"


def _parse_time(value: Any) -> datetime:
    return value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def check_invariants(resp: Mapping[str, Any]) -> list[str]:
    problems: list[str] = []
    add = problems.append

    # gate
    reasons = resp["gate"]["reasons"]
    codes = [r["code"] for r in reasons]
    for r in reasons:
        if REASON_SEVERITY.get(r["code"]) != r["severity"]:
            add(f"gate: {r['code']} must have severity {REASON_SEVERITY.get(r['code'])}, not {r['severity']}")
    if len(set(codes)) != len(codes):
        add("gate: a reason code appears twice")
    expected = decision_for([r["severity"] for r in reasons])
    if resp["gate"]["decision"] != expected:
        add(f"gate: decision is {resp['gate']['decision']} but the reasons imply {expected}")

    # classification
    cls = resp["classification"]
    for head in ("type", "queue", "priority"):
        h = cls[head]
        if h["label"] not in h["probs"]:
            add(f"classification.{head}: label {h['label']!r} is missing from probs")
        elif abs(h["probs"][h["label"]] - h["confidence"]) > 1e-6:
            add(f"classification.{head}: confidence must equal probs[label]")
    for head in ("type", "priority"):
        total = sum(cls[head]["probs"].values())
        if abs(total - 1.0) > 0.02:
            add(f"classification.{head}: probs sum to {total:.3f}, expected 1")
    if sum(cls["queue"]["probs"].values()) > 1.02:
        add("classification.queue: probs sum to more than 1")
    if len(cls["queue"]["probs"]) > 5:
        add("classification.queue: probs must hold at most the top 5 queues")
    if cls["queue"]["votes"] > cls["queue"]["k"]:
        add("classification.queue: votes cannot exceed k")
    if abs(cls["priority"]["probs"].get("high", -1) - cls["priority"]["p_high"]) > 1e-6:
        add("classification.priority: p_high must equal probs['high']")

    # retrieval and precedents
    precedents = resp["precedents"]
    ids = [p["ticket_id"] for p in precedents]
    sims = [p["similarity"] for p in precedents]
    retrieval = resp["retrieval"]
    if sims != sorted(sims, reverse=True):
        add("precedents: must be sorted by similarity, best first")
    if len(set(ids)) != len(ids):
        add("precedents: a ticket_id appears twice")
    if len(precedents) > retrieval["k"]:
        add("precedents: more entries than retrieval.k")
    expected_top = sims[0] if sims else 0.0
    if abs(retrieval["top_similarity"] - expected_top) > 1e-9:
        add("retrieval.top_similarity must equal precedents[0].similarity (0 when there are none)")
    route = retrieval["route"]
    scored = [q["queue"] for q in route["queues"]]
    if [q["score"] for q in route["queues"]] != sorted((q["score"] for q in route["queues"]), reverse=True):
        add("retrieval.route.queues: must be sorted by score, best first")
    if not set(route["searched"]) <= set(scored):
        add("retrieval.route.searched: every searched queue must appear in route.queues")
    if not route["searched"] and not route["fallback_global"]:
        add("retrieval.route: searched can only be empty when fallback_global is true")

    # draft
    draft = resp["draft"]
    v = draft["validation"]
    in_text = list(dict.fromkeys(CITATION_RE.findall(draft["text"])))
    if in_text != list(draft["citations"]):
        add("draft.citations must list exactly the [TKT-xxxxx] ids in draft.text, in order of first use")
    if not set(draft["citations"]) <= set(ids):
        add("draft: cites a ticket that is not in precedents")
    if v["passed"] != (v["citations_ok"] and v["numbers_ok"] and v["language_ok"]):
        add("draft.validation.passed must equal citations_ok and numbers_ok and language_ok")
    if draft["mode"] == "holding" and draft["citations"]:
        add("draft: a holding reply must not cite precedents")
    if draft["mode"] == "holding" and resp["gate"]["decision"] == "AUTO_DRAFT":
        add("gate: a holding reply has nothing to ground it, so it can never be AUTO_DRAFT")
    if draft["mode"] == "extractive" and not draft["citations"]:
        add("draft: an extractive reply must cite the precedent it quotes")
    if draft["mode"] == "generated" and not draft["citations"] and v["passed"]:
        add("draft: a generated reply that cites nothing cannot pass validation")
    if draft["mode"] == "extractive" and "ENGINE_DEGRADED" not in codes:
        add("draft: an extractive reply means the LLM failed, so ENGINE_DEGRADED must be a reason")
    ungrounded = draft["mode"] == "generated" and not v["passed"]
    if ungrounded != ("UNGROUNDED_DRAFT" in codes):
        add("gate: UNGROUNDED_DRAFT fires exactly when a generated draft fails validation")

    # language
    lang = resp["language"]
    supported = lang["code"] in SUPPORTED_LANGUAGES
    if lang["supported"] != supported:
        add("language.supported must be true exactly for en and de")
    if supported != ("UNSUPPORTED_LANGUAGE" not in codes):
        add("gate: UNSUPPORTED_LANGUAGE fires exactly when the language is not en or de")
    expected_reply = lang["code"] if supported else "en"
    if draft["language"] != expected_reply:
        add(f"draft.language must be {expected_reply} (detected language, or en when unsupported)")

    # burst
    if (resp["burst"] is not None) != ("ACTIVE_OUTAGE" in codes):
        add("burst must be present exactly when ACTIVE_OUTAGE is a reason")

    # latency
    lat = resp["latency_ms"]
    stage_sum = sum(lat[k] for k in _STAGE_KEYS) + lat.get("gateway", 0.0)
    if lat["total"] + 1.0 < stage_sum:
        add(f"latency_ms.total ({lat['total']}) is less than the sum of the stages ({stage_sum:.1f})")

    # time
    if _parse_time(resp["processed_at"]) < _parse_time(resp["created_at"]):
        add("processed_at is earlier than created_at")

    return problems
