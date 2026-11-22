"""Provider preference: OpenAI first, Gemini fallback; one embedding provider per index."""

from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from engine.app import settings as settings_module
from engine.app.common import providers
from engine.app.common.errors import LLMError, LLMUnavailable
from engine.app.common.openai_client import OpenAIClient
from engine.app.generate.prompt import DraftOut


def configure(monkeypatch, **env):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    settings_module.get_settings.cache_clear()
    return settings_module.get_settings()


class APIStatusError(Exception):
    def __init__(self, code):
        super().__init__(f"HTTP {code}")
        self.status_code = code


class FakeOpenAISdk:
    """Just enough of the openai SDK surface."""

    def __init__(self, fail_first=0, fail_code=429, refusal=None, parsed=True, content=None):
        self.calls, self.fail_first, self.fail_code = 0, fail_first, fail_code
        self.last_parse_kwargs = {}
        self.embed_inputs = []
        sdk = self

        class Embeddings:
            def create(self, model, input, dimensions):
                sdk.calls += 1
                if sdk.calls <= sdk.fail_first:
                    raise APIStatusError(sdk.fail_code)
                sdk.embed_inputs.append(list(input))
                data = [SimpleNamespace(index=i, embedding=[3.0, 4.0] + [0.0] * (dimensions - 2)) for i in reversed(range(len(input)))]
                return SimpleNamespace(data=data, usage=SimpleNamespace(prompt_tokens=9))

        class Completions:
            def parse(self, **kw):
                sdk.calls += 1
                sdk.last_parse_kwargs = kw
                if sdk.calls <= sdk.fail_first:
                    raise APIStatusError(sdk.fail_code)
                out = DraftOut(reply="ok", citations=["TKT-00001"], insufficient_evidence=False, unsupported_requests=[])
                msg = SimpleNamespace(refusal=refusal, parsed=out if parsed else None, content=content)
                return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=SimpleNamespace(prompt_tokens=11, completion_tokens=5))

        self.embeddings = Embeddings()
        self.chat = SimpleNamespace(completions=Completions())


def oa(monkeypatch, sdk, **env):
    configure(monkeypatch, OPENAI_API_KEY="sk-test", **env)
    return OpenAIClient(sdk=sdk, sleep=lambda s: None)


# ---- preference order ------------------------------------------------------------


def test_openai_is_preferred_then_gemini(monkeypatch):
    s = configure(monkeypatch, OPENAI_API_KEY="sk-a", GEMINI_API_KEY="g-a")
    assert s.generation_providers() == ["openai", "gemini"] and s.embedding_provider() == "openai"


def test_only_the_configured_provider_is_used(monkeypatch):
    s = configure(monkeypatch, GEMINI_API_KEY="g-a")
    assert s.generation_providers() == ["gemini"] and s.embedding_provider() == "gemini"
    assert configure(monkeypatch, GEMINI_API_KEY="", OPENAI_API_KEY="sk-a").generation_providers() == ["openai"]
    s = configure(monkeypatch, OPENAI_API_KEY="")
    assert s.generation_providers() == [] and s.embedding_provider() is None and not s.llm_configured


def test_provider_can_be_forced(monkeypatch):
    s = configure(monkeypatch, OPENAI_API_KEY="sk-a", GEMINI_API_KEY="g-a", LLM_PROVIDER="gemini", EMBED_PROVIDER="gemini")
    assert s.generation_providers() == ["gemini"] and s.embedding_provider() == "gemini"


def test_generation_falls_back_to_gemini_when_openai_fails(monkeypatch):
    configure(monkeypatch, OPENAI_API_KEY="sk-a", GEMINI_API_KEY="g-a")
    calls = []

    class Bad:
        def generate_json(self, prompt, schema, **kw):
            calls.append("openai")
            raise LLMUnavailable("rate limited")

    class Good:
        def generate_json(self, prompt, schema, **kw):
            calls.append("gemini")
            return {"reply": "from gemini"}

    monkeypatch.setattr(providers, "_client", lambda name: Bad() if name == "openai" else Good())
    assert providers.generate_json("p", DraftOut) == {"reply": "from gemini"}
    assert calls == ["openai", "gemini"]


def test_generation_uses_openai_when_it_works_and_never_touches_gemini(monkeypatch):
    configure(monkeypatch, OPENAI_API_KEY="sk-a", GEMINI_API_KEY="g-a")
    calls = []
    monkeypatch.setattr(providers, "_client", lambda name: SimpleNamespace(generate_json=lambda p, s, **kw: calls.append(name) or {"reply": name}))
    assert providers.generate_json("p", DraftOut) == {"reply": "openai"} and calls == ["openai"]


def test_all_providers_failing_or_none_configured_raises_unavailable(monkeypatch):
    configure(monkeypatch, OPENAI_API_KEY="sk-a", GEMINI_API_KEY="g-a")

    def boom(name):
        def fail(p, s, **kw):
            raise LLMError(f"{name} down")

        return SimpleNamespace(generate_json=fail)

    monkeypatch.setattr(providers, "_client", boom)
    with pytest.raises(LLMUnavailable, match="openai: openai down.*gemini: gemini down"):
        providers.generate_json("p", DraftOut)
    configure(monkeypatch, OPENAI_API_KEY="", GEMINI_API_KEY="")
    with pytest.raises(LLMUnavailable, match="OPENAI_API_KEY"):
        providers.generate_json("p", DraftOut)
    with pytest.raises(LLMUnavailable, match="embedding provider"):
        providers.embed_texts(["x"])


def test_embeddings_never_fall_back_to_another_provider(monkeypatch):
    configure(monkeypatch, OPENAI_API_KEY="sk-a", GEMINI_API_KEY="g-a")
    used = []

    class Down:
        def embed_texts(self, texts):
            used.append("openai")
            raise LLMUnavailable("down")

    def pick(name):
        if name != "openai":
            pytest.fail("embeddings must not switch provider")
        return Down()

    monkeypatch.setattr(providers, "_client", pick)
    with pytest.raises(LLMUnavailable):
        providers.embed_texts(["x"])
    assert used == ["openai"]
    assert providers.embedding_identity() == {"provider": "openai", "model": "text-embedding-3-small", "dim": 768}


# ---- OpenAI client ------------------------------------------------------------------


def test_openai_embeddings_are_ordered_normalised_batched_and_768(monkeypatch):
    sdk = FakeOpenAISdk()
    vecs = oa(monkeypatch, sdk).embed_texts([f"t{i}" for i in range(300)] + [""])
    assert len(vecs) == 301 and all(len(v) == 768 for v in vecs)
    assert [len(b) for b in sdk.embed_inputs] == [256, 45] and sdk.embed_inputs[-1][-1] == " "
    assert math.isclose(sum(x * x for x in vecs[0]), 1.0) and vecs[0][:2] == pytest.approx([0.6, 0.8])


def test_openai_retries_rate_limits_but_not_bad_requests(monkeypatch):
    sdk = FakeOpenAISdk(fail_first=2, fail_code=429)
    assert len(oa(monkeypatch, sdk).embed_texts(["a"])) == 1 and sdk.calls == 3
    sdk = FakeOpenAISdk(fail_first=5, fail_code=400)
    with pytest.raises(LLMUnavailable):
        oa(monkeypatch, sdk).embed_texts(["a"])
    assert sdk.calls == 1


def test_openai_wrong_embedding_size_is_an_error(monkeypatch):
    sdk = FakeOpenAISdk()
    c = oa(monkeypatch, sdk)
    sdk.embeddings.create = lambda model, input, dimensions: SimpleNamespace(data=[SimpleNamespace(index=0, embedding=[1.0, 0.0])], usage=None)
    with pytest.raises(LLMError, match="wrong shape"):
        c.embed_texts(["a"])


def test_openai_generate_uses_structured_output_and_counts_tokens(monkeypatch):
    sdk = FakeOpenAISdk()
    c = oa(monkeypatch, sdk)
    data = c.generate_json("hello", DraftOut, max_output_tokens=300)
    assert data["reply"] == "ok" and data["citations"] == ["TKT-00001"]
    kw = sdk.last_parse_kwargs
    assert kw["response_format"] is DraftOut and kw["max_completion_tokens"] == 300 and kw["messages"][0]["content"] == "hello"
    assert "temperature" not in kw  # default model is gpt-5.x, which rejects a custom temperature
    assert c.usage["input_tokens"] == 11 and c.usage["output_tokens"] == 5


def test_openai_gpt4_models_get_a_temperature(monkeypatch):
    sdk = FakeOpenAISdk()
    oa(monkeypatch, sdk, OPENAI_GEN_MODEL="gpt-4.1-mini").generate_json("p", DraftOut)
    assert sdk.last_parse_kwargs["temperature"] == 0.2


def test_openai_refusal_and_empty_output_are_errors(monkeypatch):
    with pytest.raises(LLMError, match="refused"):
        oa(monkeypatch, FakeOpenAISdk(refusal="no")).generate_json("p", DraftOut)
    with pytest.raises(LLMError, match="no content"):
        oa(monkeypatch, FakeOpenAISdk(parsed=False, content="")).generate_json("p", DraftOut)
    assert oa(monkeypatch, FakeOpenAISdk(parsed=False, content='{"reply": "x"}')).generate_json("p", DraftOut) == {"reply": "x"}


def test_unconfigured_openai_is_unavailable_not_a_crash(monkeypatch):
    configure(monkeypatch, OPENAI_API_KEY="")
    with pytest.raises(LLMUnavailable, match="OPENAI_API_KEY"):
        OpenAIClient().embed_texts(["a"])


# ---- index guard ---------------------------------------------------------------------


def test_search_refuses_an_index_built_with_a_different_embedding_model(monkeypatch):
    from engine.app import stages_live

    configure(monkeypatch, OPENAI_API_KEY="sk-a")
    stages_live.reset()
    redis = SimpleNamespace(hgetall=lambda key: {b"provider": b"gemini", b"model": b"gemini-embedding-2", b"dim": b"768"})
    monkeypatch.setattr(stages_live, "_conn", lambda: redis)
    with pytest.raises(RuntimeError, match="built with gemini/gemini-embedding-2.*openai/text-embedding-3-small"):
        stages_live.check_index_matches_embeddings()
    redis.hgetall = lambda key: {b"provider": b"openai", b"model": b"text-embedding-3-small", b"dim": b"768"}
    stages_live.check_index_matches_embeddings()  # a matching index is accepted
    stages_live.reset()
