"""Drafts that need no LLM: the holding reply and the extractive fallback.

* holding: used when there is nothing to ground a reply on (no precedents). It promises
  nothing and cites nothing, so it can never invent a refund, a price or a deadline.
* extractive: used when the LLM fails. It quotes the best precedent's answer verbatim
  and cites it. The gate adds ENGINE_DEGRADED, so it always goes to human review.
"""

from __future__ import annotations

from typing import Any

_HELLO = {"en": "Hello,", "de": "Guten Tag,"}
_SIGN = {"en": "Best regards,\nSupport Team", "de": "Mit freundlichen Grüßen\nIhr Support-Team"}
_HOLDING = {
    "en": "Thank you for your message. We have received your request, and a specialist will review it and reply as soon as possible.",
    "de": "vielen Dank für Ihre Nachricht. Wir haben Ihre Anfrage erhalten; eine Fachkraft prüft sie und meldet sich so schnell wie möglich bei Ihnen.",
}
_EXTRACTIVE_LEAD = {
    "en": "A similar case [{ticket_id}] was resolved as follows:",
    "de": "Ein ähnlicher Fall [{ticket_id}] wurde so gelöst:",
}

_EXTRACT_MAX_CHARS = 700


def _letter(lang: str, core: str) -> str:
    return f"{_HELLO[lang]}\n\n{core}\n\n{_SIGN[lang]}"


def holding_reply(lang: str) -> dict[str, Any]:
    return {"language": lang, "text": _letter(lang, _HOLDING[lang]), "citations": [], "mode": "holding"}


def extractive_reply(lang: str, ticket_id: str, answer: str) -> dict[str, Any]:
    quote = " ".join(answer.split())
    if len(quote) > _EXTRACT_MAX_CHARS:
        quote = quote[:_EXTRACT_MAX_CHARS].rsplit(" ", 1)[0] + " …"
    core = f"{_EXTRACTIVE_LEAD[lang].format(ticket_id=ticket_id)} {quote}"
    return {"language": lang, "text": _letter(lang, core), "citations": [ticket_id], "mode": "extractive"}


def fallback_draft(lang: str, precedents: list[dict[str, Any]], evidence: dict[str, str]) -> dict[str, Any]:
    """Extractive reply from the best precedent written in the reply language, else the holding reply.

    Quoting an answer in another language would put English into a German reply (or the reverse),
    which the validator would reject, so those precedents are skipped.
    """
    for p in precedents:
        if p.get("language") != lang:
            continue
        answer = evidence.get(p["ticket_id"]) or p.get("answer_snippet", "")
        if answer.strip():
            return extractive_reply(lang, p["ticket_id"], answer)
    return holding_reply(lang)
