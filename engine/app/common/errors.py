"""Provider-neutral LLM errors. Callers catch these and degrade; they never see an SDK exception."""

from __future__ import annotations


class LLMError(RuntimeError):
    """A model call failed or returned something unusable."""


class LLMUnavailable(LLMError):
    """The provider is not configured, or gave up after retries."""
