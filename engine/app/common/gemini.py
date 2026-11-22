"""Shared Gemini client: embeddings and JSON generation (task H-07).

The ML engineer imports ``embed_texts`` for KB indexing and the retriever uses it for live
queries, so both sides get identical settings: the same model, 768 dimensions, L2-normalised.

    from engine.app.common.gemini import embed_texts, generate_json

Failures raise GeminiError. ``GeminiUnavailable`` means "not configured or gave up", and
callers fall back (extractive draft, human review) instead of failing the request.
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

log = logging.getLogger("sentineldesk.gemini")
T = TypeVar("T")

EMBED_BATCH = 100  # the Gemini embed API accepts up to 100 texts per call
MIN_DEADLINE_S = 10.0  # the API rejects any request deadline under 10 s (verified live)
RETRYABLE_CODES = {408, 429, 500, 502, 503, 504}


GeminiError = LLMError  # kept for callers that import the old names
GeminiUnavailable = LLMUnavailable


def l2_normalize(vec: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    return [float(x) for x in vec] if norm == 0 else [x / norm for x in vec]


def _status(exc: Exception) -> int | None:
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    return code if isinstance(code, int) else None


def _is_retryable(exc: Exception) -> bool:
    code = _status(exc)
    if code is not None:
        return code in RETRYABLE_CODES
    return isinstance(exc, (TimeoutError, ConnectionError))


class GeminiClient:
    name = "gemini"

    def __init__(self, settings: Settings | None = None, sdk: Any = None, sleep: Callable[[float], None] = time.sleep):
        self.settings = settings or get_settings()
        self._sdk = sdk
        self._sleep = sleep
        self._slots = threading.BoundedSemaphore(max(1, self.settings.gemini_concurrency))
        self._lock = threading.Lock()
        self.usage = {"embed_calls": 0, "generate_calls": 0, "input_tokens": 0, "output_tokens": 0}

    # ---- plumbing --------------------------------------------------------
    @property
    def sdk(self) -> Any:
        if self._sdk is None:
            if not self.settings.gemini_api_key:
                raise GeminiUnavailable("GEMINI_API_KEY is not set.")
            from google import genai  # imported lazily so the engine boots without the package

            self._sdk = genai.Client(api_key=self.settings.gemini_api_key)
        return self._sdk

    def _call(self, fn: Callable[[], T], *, attempts: int, deadline: float | None = None) -> T:
        last: Exception | None = None
        for attempt in range(attempts):
            try:
                with self._slots:
                    return fn()
            except GeminiError:
                raise
            except Exception as exc:  # noqa: BLE001 - SDK raises many types
                last = exc
                if not _is_retryable(exc) or attempt == attempts - 1:
                    break
                delay = min(8.0, 0.5 * 2**attempt) * (0.5 + random.random() / 2)
                if deadline is not None and time.monotonic() + delay >= deadline:
                    break
                log.warning("Gemini call failed (%s), retrying in %.1fs", type(exc).__name__, delay)
                self._sleep(delay)
        raise GeminiUnavailable(f"Gemini call failed: {type(last).__name__}: {last}") from last

    def _count(self, **deltas: int) -> None:
        with self._lock:
            for k, v in deltas.items():
                self.usage[k] += v

    # ---- embeddings ------------------------------------------------------
    def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        """One normalised vector per text, in order, ``EMBED_DIM`` long."""
        if not texts:
            return []
        from google.genai import types

        cfg = types.EmbedContentConfig(output_dimensionality=self.settings.embed_dim)
        out: list[list[float]] = []
        for i in range(0, len(texts), EMBED_BATCH):
            batch = [t if t.strip() else " " for t in texts[i : i + EMBED_BATCH]]
            # gemini-embedding-2 is multimodal: a plain list of strings is ONE document and returns ONE
            # vector. Wrapping each text in its own Content gives one vector per text (verified live).
            contents = [types.Content(parts=[types.Part(text=t)]) for t in batch]
            res = self._call(
                lambda c=contents: self.sdk.models.embed_content(model=self.settings.embed_model, contents=c, config=cfg),
                attempts=5,
            )
            vectors = [list(e.values) for e in res.embeddings]
            if len(vectors) != len(batch) or any(len(v) != self.settings.embed_dim for v in vectors):
                raise GeminiError(f"Embedding response has the wrong shape (expected {len(batch)} x {self.settings.embed_dim}).")
            out.extend(l2_normalize(v) for v in vectors)
            self._count(embed_calls=1)
        return out

    # ---- generation ------------------------------------------------------
    def generate_json(
        self,
        prompt: str,
        schema: Any,
        *,
        timeout_s: float | None = None,
        temperature: float = 0.2,
        max_output_tokens: int = 700,
    ) -> dict[str, Any]:
        """Ask the model for JSON matching ``schema`` (a Pydantic model class). Returns the parsed dict."""
        if not self.settings.gen_model:
            raise GeminiUnavailable("GEN_MODEL is not set.")
        from google.genai import types

        timeout = max(timeout_s or self.settings.llm_timeout_s, MIN_DEADLINE_S)
        deadline = time.monotonic() + timeout
        cfg = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            http_options=types.HttpOptions(timeout=int(timeout * 1000)),
        )
        res = self._call(
            lambda: self.sdk.models.generate_content(model=self.settings.gen_model, contents=prompt, config=cfg),
            attempts=2,
            deadline=deadline,
        )
        usage = getattr(res, "usage_metadata", None)
        self._count(
            generate_calls=1,
            input_tokens=getattr(usage, "prompt_token_count", 0) or 0,
            output_tokens=getattr(usage, "candidates_token_count", 0) or 0,
        )
        text = getattr(res, "text", None)
        if not text:
            raise GeminiError("The model returned no text (blocked or empty).")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise GeminiError(f"The model did not return valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise GeminiError("The model returned JSON that is not an object.")
        return data


# ---- module-level helpers (what other folders import) --------------------

_client: GeminiClient | None = None
_client_lock = threading.Lock()


def get_gemini() -> GeminiClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = GeminiClient()
        return _client


def set_gemini(client: GeminiClient | None) -> None:
    """Swap the shared client (tests) or reset it with None."""
    global _client
    with _client_lock:
        _client = client


def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    return get_gemini().embed_texts(texts)


def generate_json(prompt: str, schema: Any, **kwargs: Any) -> dict[str, Any]:
    return get_gemini().generate_json(prompt, schema, **kwargs)
