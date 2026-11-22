"""Draft validator (task H-11): a generated reply must be grounded or it goes to a human.

Three checks, none of which trust the model:

* citations: the reply cites at least one precedent, and every [TKT-xxxxx] is one of the
  retrieved precedents (so the model can't invent a ticket).
* numbers: every number in the reply (amounts, percentages, durations, versions) also
  appears in the evidence or in the customer's own ticket. A refund amount or "within
  2 business days" that no precedent supports fails here.
* language: the reply is in the requested language.

Limit: only digits are checked. A spelled-out number ("two business days") passes this
check; the prompt forbids it and the human review catches the rest.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

CITATION = re.compile(r"\[(TKT-\d{5})\]")
ANY_TKT = re.compile(r"TKT-\d{5}")
NUMBER = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)*")

_EN = {"the", "and", "is", "are", "was", "were", "you", "your", "we", "our", "please", "with", "that", "this", "for", "have", "has", "will", "can", "not", "from", "thank", "thanks", "hello", "regards", "team", "reply", "ticket", "support"}
_DE = {"der", "die", "das", "und", "ist", "sind", "war", "sie", "ihr", "ihre", "ihren", "wir", "unser", "unsere", "bitte", "mit", "dass", "für", "haben", "hat", "wird", "kann", "nicht", "von", "danke", "vielen", "guten", "tag", "grüßen", "freundlichen", "anfrage", "antwort", "ticket"}
_WORD = re.compile(r"[a-zäöüß]+")


@dataclass
class Check:
    citations_ok: bool
    numbers_ok: bool
    language_ok: bool
    citations: list[str]
    issues: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.citations_ok and self.numbers_ok and self.language_ok


def citations_in(text: str) -> list[str]:
    return list(dict.fromkeys(CITATION.findall(text)))


def _norm_number(token: str) -> str:
    token = token.replace(",", ".").rstrip(".")
    if "." in token:
        token = token.rstrip("0").rstrip(".")
    return token.lstrip("0") or "0"


def numbers_in(text: str) -> set[str]:
    return {_norm_number(m) for m in NUMBER.findall(ANY_TKT.sub(" ", text))}


def detect_language(text: str) -> str | None:
    """'en', 'de' or None when the text is too short or too mixed to tell."""
    words = _WORD.findall(text.lower())
    if len(words) < 6:
        return None
    en, de = sum(w in _EN for w in words), sum(w in _DE for w in words)
    if en == de:
        return None
    return "en" if en > de else "de"


def validate_reply(
    reply: str,
    *,
    language: str,
    precedents: list[dict[str, Any]],
    answers: dict[str, str],
    ticket_text: str,
) -> Check:
    known = {p["ticket_id"] for p in precedents}
    cited = citations_in(reply)
    issues: list[str] = []

    unknown = [c for c in cited if c not in known]
    if unknown:
        issues.append(f"Cites tickets that are not in the evidence: {', '.join(unknown)}.")
    if not cited:
        issues.append("The reply does not cite any precedent as [TKT-xxxxx].")
    citations_ok = bool(cited) and not unknown

    evidence = " ".join(
        [ticket_text]
        + [answers.get(p["ticket_id"]) or p.get("answer_snippet", "") for p in precedents]
        + [p.get("subject", "") for p in precedents]
    )
    allowed = numbers_in(evidence)
    unsupported = sorted(n for n in numbers_in(reply) if n not in allowed)
    if unsupported:
        issues.append(
            "Contains numbers that appear in neither the evidence nor the ticket: "
            + ", ".join(unsupported)
            + ". Remove them or say a specialist will confirm."
        )
    numbers_ok = not unsupported

    detected = detect_language(reply)
    language_ok = detected in (None, language)
    if not language_ok:
        issues.append(f"The reply must be written in {'German' if language == 'de' else 'English'}.")

    return Check(citations_ok, numbers_ok, language_ok, cited, issues)
