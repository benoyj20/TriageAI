"""
DA-07: Bilingual Keyword Rules (EN & DE)
Defines high-precision regex patterns for security breaches, prompt injections,
unsupported financial/SLA demands, and legal/compliance inquiries.
"""

import re
from typing import Dict, List

# 1. Security Incidents (P1)
SECURITY_KEYWORDS_EN = [
    r"\bransomware\b", r"\bdata\s+breach\b", r"\bsecurity\s+breach\b",
    r"\bhacked\b", r"\bmalware\b", r"\bddos\b", r"\bcredential\s+leak\b",
    r"\bunauthorized\s+access\b", r"\bcompromised\s+account\b", r"\bphishing\s+attack\b",
    r"\bkeylogger\b", r"\bbackdoor\b", r"\bzero-day\b",
    r"\bransom\s+(note|demand|message)s?\b",
]

SECURITY_KEYWORDS_DE = [
    r"\bransomware\b", r"\bdatenpanne\b", r"\bsicherheitsvorfall\b",
    r"\berpressungstrojaner\b", r"\bgehackt\b", r"\bschadsoftware\b",
    r"\bunbefugter\s+zugriff\b", r"\bkompromittiert\b", r"\bpasswort-diebstahl\b",
    r"\bangriff\b", r"\bspionage\b", r"\blösegeld(forderung)?\b",
]

# 2. Prompt Injections & Jailbreak Attempts (P2)
# Each pattern needs an instruction-like object ("previous instructions", "your rules", "system prompt"),
# so ordinary tickets ("please ignore my previous email", "users ignore the password rules") don't match.
PROMPT_INJECTION_PATTERNS = [
    # English
    r"(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+)?(of\s+)?(the\s+|your\s+|these\s+)?"
    r"(previous|prior|above|earlier|preceding|system|original)\s+(instructions|rules|prompts?|guidelines|directions)",
    r"(ignore|disregard|forget|override|bypass)\s+(all|your)\s+(instructions|rules|guidelines)",
    r"system\s*-?\s*prompt",
    r"(reveal|print|show|output|repeat|display|leak|dump)\s+(me\s+)?(your|the\s+(hidden|internal|system|full))\s+"
    r"(full\s+|entire\s+|internal\s+|hidden\s+)?(prompt|instructions|rules|guidelines)",
    r"you\s+are\s+now\s+(in\s+)?(dan|developer|unfiltered|jailbroken|god|unrestricted)\b",
    r"developer\s+mode",
    r"jailbreak",
    r"\bdan\s+mode\b",
    r"act\s+as\s+(an?\s+)?(unrestricted|unfiltered|jailbroken)",
    r"new\s+rule:",
    r"output\s+your\s+instructions",
    r"repeat\s+the\s+prompt\s+above",
    # German
    r"(ignoriere|ignorier|vergiss|missachte|übergehe|umgehe)\s+(bitte\s+)?(alle\s+|sämtliche\s+|die\s+|deine\s+)?"
    r"(vorherigen|bisherigen|obigen|früheren|vorigen|ursprünglichen)\s+(anweisungen|regeln|instruktionen|vorgaben|befehle)",
    r"(ignoriere|ignorier|vergiss|missachte)\s+(alle|deine|sämtliche)\s+(anweisungen|regeln|instruktionen|vorgaben)",
    r"(zeige|gib|nenne|verrate|wiederhole)\s+(mir\s+)?(deine|die\s+internen|den\s+system|die\s+geheimen)\s*-?\s*"
    r"(prompt|regeln|anweisungen|instruktionen|vorgaben)",
    r"systemprompt|system-prompt",
    r"entwicklermodus",
]

# 3. Unsupported Requests & Guarantees (P2)
UNSUPPORTED_REQUEST_KEYWORDS = [
    r"\b100%\s+refund\b", r"\bfull\s+refund\b", r"\brefund\s+guarantee\b",
    r"\bcompensation\b", r"\bcash\s+payout\b", r"\bwire\s+transfer\b",
    r"\bbitcoin\b", r"\bcrypto\b", r"\bsla\s+payout\b", r"\bsla\s+guarantee\b",
    r"\bfinancial\s+damages\b", r"\berstattung\b", r"\brückerstattung\b",
    r"\bentschädigung\b", r"\bschadenersatz\b", r"\bgeld\s+zurück\b"
]

# 4. Legal & Compliance Inquiries (P2)
LEGAL_KEYWORDS = [
    r"\blawyer\b", r"\battorney\b", r"\blawsuit\b", r"\bsue\s+you\b",
    r"\bcourt\b", r"\blegal\s+action\b", r"\bsubpoena\b", r"\bgdpr\b",
    r"\bdsgvo\b", r"\barticle\s+17\b", r"\bright\s+to\s+be\s+forgotten\b",
    r"\bdata\s+protection\s+officer\b", r"\banwalt\b", r"\brechtsanwalt\b",
    r"\bklage\b", r"\bgericht\b", r"\bvorladung\b", r"\blöschanspruch\b",
    r"\bdatenschutzbeauftragter\b"
]

def compile_patterns(patterns: List[str]) -> re.Pattern:
    combined = "|".join(f"(?:{p})" for p in patterns)
    return re.compile(combined, re.IGNORECASE)

PATTERNS: Dict[str, re.Pattern] = {
    "SECURITY_EN": compile_patterns(SECURITY_KEYWORDS_EN),
    "SECURITY_DE": compile_patterns(SECURITY_KEYWORDS_DE),
    "PROMPT_INJECTION": compile_patterns(PROMPT_INJECTION_PATTERNS),
    "UNSUPPORTED_REQUEST": compile_patterns(UNSUPPORTED_REQUEST_KEYWORDS),
    "LEGAL": compile_patterns(LEGAL_KEYWORDS)
}

def match_keywords(text: str) -> Dict[str, List[str]]:
    matches = {}
    for category, pat in PATTERNS.items():
        found = [m.group(0) for m in pat.finditer(text)]
        if found:
            matches[category] = found
    return matches
