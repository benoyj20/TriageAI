"""One embedder for the KB and live queries (README: same settings for both).

Backends (EMBED_BACKEND): "auto" (default: the provider chosen by engine.app.common.providers, OpenAI first,
then Gemini), "openai", "gemini", or "hash" (offline, deterministic, for tests/CI only). Vectors from different backends must never be mixed; the backend is stored in the
embedding manifest and checked by ml/indexing/build_index.py.
"""
from __future__ import annotations

import hashlib
import os
import re
import time

import numpy as np

EMBED_MODEL = os.getenv("EMBED_MODEL", "gemini-embedding-2")
EMBED_DIM = int(os.getenv("EMBED_DIM", "768"))
BACKEND = os.getenv("EMBED_BACKEND", "auto")
MAX_CHARS = 8000  # keep requests bounded; tickets are far shorter


def _unit(m: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(m, axis=1, keepdims=True)
    return (m / np.clip(n, 1e-12, None)).astype(np.float32)


class HashEmbedder:
    """Word + char-trigram feature hashing into EMBED_DIM; not semantic, but stable and offline."""
    name = "hash"

    def __init__(self, dim: int = EMBED_DIM):
        self.dim = dim

    def _vec(self, text: str) -> np.ndarray:
        v = np.zeros(self.dim, dtype=np.float32)
        t = text.lower()
        feats = re.findall(r"\w+", t) + [t[i:i + 3] for i in range(max(len(t) - 2, 0))]
        for f in feats:
            h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "little")
            v[h % self.dim] += 1.0 if (h >> 63) & 1 else -1.0
        return v

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), np.float32)
        return _unit(np.stack([self._vec(t) for t in texts]))


class GeminiEmbedder:
    name = "gemini"

    def __init__(self, dim: int = EMBED_DIM, model: str = EMBED_MODEL, batch: int = 100):
        from google import genai  # lazy: not needed for the hash backend
        self.client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        self.dim, self.model, self.batch = dim, model, batch

    def _call(self, chunk: list[str]) -> np.ndarray:
        from google.genai import types
        for attempt in range(6):
            try:
                # gemini-embedding-2 treats a plain list of strings as ONE document (one vector back);
                # one Content per text gives one vector per text.
                r = self.client.models.embed_content(
                    model=self.model, contents=[types.Content(parts=[types.Part(text=t)]) for t in chunk],
                    config=types.EmbedContentConfig(output_dimensionality=self.dim))
                vecs = np.array([e.values for e in r.embeddings], dtype=np.float32)
                if len(vecs) != len(chunk):
                    raise ValueError(f"embedding count {len(vecs)} != input count {len(chunk)}")
                return vecs
            except Exception:
                if attempt == 5:
                    raise
                time.sleep(min(2 ** attempt, 30))  # quota / transient errors

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), np.float32)
        out = [self._call([t[:MAX_CHARS] or " " for t in texts[i:i + self.batch]])
               for i in range(0, len(texts), self.batch)]
        return _unit(np.vstack(out))  # truncated (MRL) vectors must be re-normalised


class ProviderEmbedder:
    """Embeds through the shared provider layer (OpenAI or Gemini), one vector per text, unit length."""

    def __init__(self, provider: str | None = None, batch: int = 200):
        from engine.app.common import providers
        from engine.app.settings import get_settings

        s = get_settings()
        self.provider = provider or s.embedding_provider()
        if not self.provider:
            raise RuntimeError("No embedding provider configured. Set OPENAI_API_KEY (preferred) or GEMINI_API_KEY.")
        self.name = self.provider
        self.model = s.openai_embed_model if self.provider == "openai" else s.embed_model
        self.dim, self.batch = s.embed_dim, batch
        self._embed = providers.embed_texts

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), np.float32)
        out = [np.asarray(self._embed([t[:MAX_CHARS] or " " for t in texts[i:i + self.batch]], self.provider), dtype=np.float32)
               for i in range(0, len(texts), self.batch)]
        return _unit(np.vstack(out))


def get_embedder(backend: str | None = None):
    backend = (backend or BACKEND).lower()
    if backend == "hash":
        return HashEmbedder()
    return ProviderEmbedder(None if backend == "auto" else backend)
