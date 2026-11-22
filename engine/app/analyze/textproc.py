"""Text handling shared by training (ml/) and serving (engine/). Single source of truth."""
from __future__ import annotations

import re

_WS = re.compile(r"\s+")


def clean_text(s) -> str:
    """Collapse whitespace; None/NaN/non-strings -> ''. Casing and punctuation are kept."""
    if s is None or (isinstance(s, float) and s != s):
        return ""
    return _WS.sub(" ", str(s)).strip()


def build_text(subject, body) -> str:
    """Model/embedding input. Subject is optional (empty subjects are common)."""
    subj, body = clean_text(subject), clean_text(body)
    return f"{subj}\n{body}" if subj else body
