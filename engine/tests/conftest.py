"""Tests never touch the network or a developer's real .env."""

from __future__ import annotations

import pytest

from engine.app import settings as settings_module
from engine.app.common import chunk_stats, gemini, openai_client


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch, tmp_path):
    # Real env vars win over .env (load_dotenv uses setdefault), so blank them out.
    for name in ("OPENAI_API_KEY", "GEMINI_API_KEY", "GEN_MODEL", "LLM_PROVIDER", "EMBED_PROVIDER", "REDIS_URL", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        monkeypatch.setenv(name, "")
    monkeypatch.setenv("ARTIFACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("UPDATE_QUERIED_COUNT", "true")
    settings_module.get_settings.cache_clear()
    gemini.set_gemini(None)
    openai_client.set_openai(None)
    chunk_stats.set_redis(None)
    yield
    settings_module.get_settings.cache_clear()
    gemini.set_gemini(None)
    openai_client.set_openai(None)
    chunk_stats.set_redis(None)
