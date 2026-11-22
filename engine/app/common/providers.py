"""One entry point for embeddings and generation, with provider preference (OpenAI first, then Gemini).

    from engine.app.common.providers import embed_texts, generate_json

* Generation: providers are tried in order (OpenAI, then Gemini), skipping any that has no key.
  If the first fails (error, timeout, rate limit) the next one answers. This is safe because every
  provider gets the same prompt and its output goes through the same validator.
* Embeddings: ONE provider, chosen from the configuration, never switched per call. Vectors from
  different models live in different spaces, so mixing them in one index silently ruins retrieval.
  To change provider, re-embed the knowledge base (ml/indexing/embed.py) and reload Redis.

Override with LLM_PROVIDER / EMBED_PROVIDER = auto | openai | gemini (default auto).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

from engine.app.common.errors import LLMError, LLMUnavailable
from engine.app.settings import get_settings

log = logging.getLogger("sentineldesk.providers")


def _client(name: str) -> Any:
    if name == "openai":
        from engine.app.common.openai_client import get_openai

        return get_openai()
    from engine.app.common.gemini import get_gemini

    return get_gemini()


def generate_json(prompt: str, schema: Any, **kwargs: Any) -> dict[str, Any]:
    """Structured generation; falls back to the next configured provider if one fails."""
    order = get_settings().generation_providers()
    if not order:
        raise LLMUnavailable("No LLM provider is configured. Set OPENAI_API_KEY (preferred) or GEMINI_API_KEY.")
    failures: list[str] = []
    for i, name in enumerate(order):
        try:
            data = _client(name).generate_json(prompt, schema, **kwargs)
            if i > 0:
                log.warning("answered by fallback provider %s (%s)", name, "; ".join(failures))
            return data
        except LLMError as exc:
            failures.append(f"{name}: {exc}")
            log.warning("generation via %s failed: %s", name, exc)
    raise LLMUnavailable("No LLM provider could answer: " + " | ".join(failures))


def embedding_identity() -> dict[str, Any]:
    s = get_settings()
    provider = s.embedding_provider()
    model = {"openai": s.openai_embed_model, "gemini": s.embed_model}.get(provider or "", "")
    return {"provider": provider, "model": model, "dim": s.embed_dim}


def embed_texts(texts: Sequence[str], provider: str | None = None) -> list[list[float]]:
    name = provider or get_settings().embedding_provider()
    if not name:
        raise LLMUnavailable("No embedding provider is configured. Set OPENAI_API_KEY (preferred) or GEMINI_API_KEY.")
    return _client(name).embed_texts(list(texts))
