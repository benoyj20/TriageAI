"""OpenAI client: embeddings and structured JSON generation (the preferred provider).

Same surface as GeminiClient (embed_texts, generate_json) so providers.py can use either.
Embeddings use text-embedding-3-* with ``dimensions`` set to EMBED_DIM, so the Redis index
keeps its 768-dimension layout. Chat uses Structured Outputs (``chat.completions.parse``)
with a Pydantic schema, so a reply that doesn't match the schema never reaches the pipeline.
"""

from __future__ import annotations

import json
import logging
import math
import random
import threading
import time
from collections.abc import Callable, Sequence
from typing import Any, TypeVar

from engine.app.common.errors import LLMError, LLMUnavailable
from engine.app.settings import Settings, get_settings

log = logging.getLogger("sentineldesk.openai")
T = TypeVar("T")

EMBED_BATCH = 256
RETRYABLE_CODES = {408, 409, 429, 500, 502, 503, 504}
RETRYABLE_NAMES = {"APIConnectionError", "APITimeoutError"}


def _l2(vec: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    return [float(x) for x in vec] if norm == 0 else [x / norm for x in vec]


def _retryable(exc: Exception) -> bool:
    code = getattr(exc, "status_code", None)
    if isinstance(code, int):
        return code in RETRYABLE_CODES
    return type(exc).__name__ in RETRYABLE_NAMES


class OpenAIClient:
    name = "openai"

    def __init__(self, settings: Settings | None = None, sdk: Any = None, sleep: Callable[[float], None] = time.sleep):
        self.settings = settings or get_settings()
        self._sdk = sdk
        self._sleep = sleep
        self._slots = threading.BoundedSemaphore(max(1, self.settings.gemini_concurrency))
        self._lock = threading.Lock()
        self.usage = {"embed_calls": 0, "generate_calls": 0, "input_tokens": 0, "output_tokens": 0}

    @property
    def sdk(self) -> Any:
        if self._sdk is None:
            if not self.settings.openai_api_key:
                raise LLMUnavailable("OPENAI_API_KEY is not set.")
            import openai  # lazy: the engine boots without the package

            self._sdk = openai.OpenAI(api_key=self.settings.openai_api_key, max_retries=0, timeout=self.settings.llm_timeout_s)
        return self._sdk

    def _call(self, fn: Callable[[], T], *, attempts: int, deadline: float | None = None) -> T:
        last: Exception | None = None
        for attempt in range(attempts):
            try:
                with self._slots:
                    return fn()
            except LLMError:
                raise
            except Exception as exc:  # noqa: BLE001 - SDK raises many types
                last = exc
                if not _retryable(exc) or attempt == attempts - 1:
                    break
                delay = min(8.0, 0.5 * 2**attempt) * (0.5 + random.random() / 2)
                if deadline is not None and time.monotonic() + delay >= deadline:
                    break
                log.warning("OpenAI call failed (%s), retrying in %.1fs", type(exc).__name__, delay)
                self._sleep(delay)
        raise LLMUnavailable(f"OpenAI call failed: {type(last).__name__}: {last}") from last

    def _count(self, **deltas: int) -> None:
        with self._lock:
            for k, v in deltas.items():
                self.usage[k] += v

    def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        """One normalised vector per text, in order, ``EMBED_DIM`` long."""
        out: list[list[float]] = []
        dim = self.settings.embed_dim
        for i in range(0, len(texts), EMBED_BATCH):
            batch = [t if t.strip() else " " for t in texts[i : i + EMBED_BATCH]]
            res = self._call(
                lambda b=batch: self.sdk.embeddings.create(model=self.settings.openai_embed_model, input=b, dimensions=dim),
                attempts=5,
            )
            vectors = [list(d.embedding) for d in sorted(res.data, key=lambda d: d.index)]
            if len(vectors) != len(batch) or any(len(v) != dim for v in vectors):
                raise LLMError(f"Embedding response has the wrong shape (expected {len(batch)} x {dim}).")
            out.extend(_l2(v) for v in vectors)
            self._count(embed_calls=1, input_tokens=getattr(getattr(res, "usage", None), "prompt_tokens", 0) or 0)
        return out

    def generate_json(
        self,
        prompt: str,
        schema: Any,
        *,
        timeout_s: float | None = None,
        temperature: float = 0.2,
        max_output_tokens: int = 700,
    ) -> dict[str, Any]:
        """Structured output matching ``schema`` (a Pydantic model class), returned as a dict."""
        model = self.settings.openai_gen_model
        if not model:
            raise LLMUnavailable("OPENAI_GEN_MODEL is not set.")
        timeout = timeout_s or self.settings.llm_timeout_s
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "response_format": schema,
            "max_completion_tokens": max_output_tokens,
            "timeout": timeout,
        }
        if model.startswith("gpt-4"):  # the gpt-5 family rejects a custom temperature
            kwargs["temperature"] = temperature
        res = self._call(lambda: self.sdk.chat.completions.parse(**kwargs), attempts=2, deadline=time.monotonic() + timeout)
        usage = getattr(res, "usage", None)
        self._count(
            generate_calls=1,
            input_tokens=getattr(usage, "prompt_tokens", 0) or 0,
            output_tokens=getattr(usage, "completion_tokens", 0) or 0,
        )
        msg = res.choices[0].message
        if getattr(msg, "refusal", None):
            raise LLMError(f"The model refused to answer: {msg.refusal}")
        parsed = getattr(msg, "parsed", None)
        if parsed is not None:
            return parsed.model_dump() if hasattr(parsed, "model_dump") else dict(parsed)
        text = getattr(msg, "content", None)
        if not text:
            raise LLMError("The model returned no content (length limit or empty).")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError(f"The model did not return valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise LLMError("The model returned JSON that is not an object.")
        return data


_client: OpenAIClient | None = None
_client_lock = threading.Lock()


def get_openai() -> OpenAIClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = OpenAIClient()
        return _client


def set_openai(client: OpenAIClient | None) -> None:
    global _client
    with _client_lock:
        _client = client
