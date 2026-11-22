"""ML-06 language detection from raw text (the live system cannot rely on the dataset's `language` column).

Returns ("en" | "de" | "other", confidence). Anything that is not en/de maps to "other" and the gate raises
UNSUPPORTED_LANGUAGE. Very short or empty text falls back to a stopword heuristic, then to "en" with low confidence.
"""
from __future__ import annotations

import re

from langdetect import DetectorFactory, detect_langs
from langdetect.lang_detect_exception import LangDetectException

DetectorFactory.seed = 0  # deterministic

SUPPORTED = {"en", "de"}
_EN = {"the", "and", "is", "to", "my", "i", "you", "we", "with", "for", "please", "not", "can", "this", "have"}
_DE = {"der", "die", "das", "und", "ist", "nicht", "ich", "wir", "sie", "mit", "für", "bitte", "kann", "ein", "wie"}
_WORD = re.compile(r"[a-zA-ZäöüÄÖÜß]+")


def _heuristic(text: str) -> tuple[str, float]:
    words = [w.lower() for w in _WORD.findall(text)]
    en, de = sum(w in _EN for w in words), sum(w in _DE for w in words)
    if en == de:
        return "en", 0.0
    return ("en", en / max(len(words), 1)) if en > de else ("de", de / max(len(words), 1))


def detect_language(text: str) -> tuple[str, float]:
    text = (text or "").strip()
    if len(text) < 12:
        return _heuristic(text)
    try:
        top = detect_langs(text)[0]
    except LangDetectException:
        return _heuristic(text)
    lang = top.lang if top.lang in SUPPORTED else "other"
    return lang, float(top.prob)
