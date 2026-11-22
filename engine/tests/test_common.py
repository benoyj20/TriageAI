"""Gemini client, R2 sync and chunk stats, with fakes (no network, no Redis)."""

from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from engine.app import settings as settings_module
from engine.app.common import chunk_stats, r2
from engine.app.common.gemini import GeminiClient, GeminiError, GeminiUnavailable, l2_normalize
from engine.app.settings import get_settings


class APIError(Exception):
    def __init__(self, code):
        super().__init__(f"HTTP {code}")
        self.code = code


class FakeModels:
    def __init__(self, dim=768, fail_first=0, fail_code=429, text='{"reply": "ok"}'):
        self.dim, self.fail_first, self.fail_code, self.text = dim, fail_first, fail_code, text
        self.embed_batches: list[int] = []
        self.calls = 0

    def embed_content(self, model, contents, config):
        self.calls += 1
        if self.calls <= self.fail_first:
            raise APIError(self.fail_code)
        # Live finding: gemini-embedding-2 returns ONE vector for a list of plain strings.
        assert all(hasattr(c, "parts") for c in contents), "each text must be its own Content"
        self.embed_batches.append(len(contents))
        return SimpleNamespace(embeddings=[SimpleNamespace(values=[3.0, 4.0] + [0.0] * (self.dim - 2)) for _ in contents])

    def generate_content(self, model, contents, config):
        self.calls += 1
        if self.calls <= self.fail_first:
            raise APIError(self.fail_code)
        return SimpleNamespace(text=self.text, usage_metadata=SimpleNamespace(prompt_token_count=11, candidates_token_count=7))


def client(monkeypatch, models, **env):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setenv("GEN_MODEL", "gen-test")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    settings_module.get_settings.cache_clear()
    return GeminiClient(sdk=SimpleNamespace(models=models), sleep=lambda s: None)


def test_embeddings_are_normalised_batched_and_ordered(monkeypatch):
    models = FakeModels()
    vectors = client(monkeypatch, models).embed_texts([f"t{i}" for i in range(230)])
    assert models.embed_batches == [100, 100, 30]
    assert len(vectors) == 230 and all(len(v) == 768 for v in vectors)
    assert math.isclose(sum(x * x for x in vectors[0]), 1.0) and vectors[0][:2] == pytest.approx([0.6, 0.8])


def test_embeddings_retry_on_rate_limit_then_succeed(monkeypatch):
    models = FakeModels(fail_first=2, fail_code=429)
    assert len(client(monkeypatch, models).embed_texts(["a"])) == 1
    assert models.calls == 3


def test_embeddings_do_not_retry_a_bad_request(monkeypatch):
    models = FakeModels(fail_first=5, fail_code=400)
    with pytest.raises(GeminiUnavailable):
        client(monkeypatch, models).embed_texts(["a"])
    assert models.calls == 1


def test_wrong_embedding_dimension_is_an_error(monkeypatch):
    with pytest.raises(GeminiError, match="wrong shape"):
        client(monkeypatch, FakeModels(dim=512)).embed_texts(["a"])


def test_generate_json_parses_counts_tokens_and_rejects_bad_output(monkeypatch):
    from engine.app.generate.prompt import DraftOut

    c = client(monkeypatch, FakeModels(text='{"reply": "hi"}'))
    assert c.generate_json("p", DraftOut) == {"reply": "hi"}
    assert c.usage["input_tokens"] == 11 and c.usage["output_tokens"] == 7 and c.usage["generate_calls"] == 1
    with pytest.raises(GeminiError, match="valid JSON"):
        client(monkeypatch, FakeModels(text="not json")).generate_json("p", DraftOut)
    with pytest.raises(GeminiError, match="no text"):
        client(monkeypatch, FakeModels(text="")).generate_json("p", DraftOut)


def test_generate_retries_once_on_503_and_then_gives_up(monkeypatch):
    from engine.app.generate.prompt import DraftOut

    models = FakeModels(fail_first=9, fail_code=503)
    with pytest.raises(GeminiUnavailable):
        client(monkeypatch, models).generate_json("p", DraftOut)
    assert models.calls == 2


def test_unconfigured_client_is_unavailable_not_a_crash():
    c = GeminiClient()
    with pytest.raises(GeminiUnavailable, match="GEMINI_API_KEY"):
        c.embed_texts(["a"])
    with pytest.raises(GeminiUnavailable, match="GEMINI_API_KEY"):
        c.generate_json("p", dict)


def test_l2_normalize_handles_zero_vector():
    assert l2_normalize([0.0, 0.0]) == [0.0, 0.0]


# ---- settings --------------------------------------------------------------


def test_settings_defaults_and_flags(monkeypatch):
    s = get_settings()
    assert (s.embed_model, s.embed_dim, s.artifact_version, s.redis_chunk_index) == ("gemini-embedding-2", 768, "v1", "idx:chunks")
    assert not s.llm_configured and not s.r2_configured
    monkeypatch.setenv("UPDATE_QUERIED_COUNT", "false")
    settings_module.get_settings.cache_clear()
    assert get_settings().update_queried_count is False


# ---- R2 ---------------------------------------------------------------------


class FakeS3:
    def __init__(self, files):
        self.files = files  # key -> bytes
        self.downloads: list[str] = []

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        keys = sorted(k for k in self.files if k.startswith(Prefix))
        start = int(ContinuationToken or 0)
        page = keys[start : start + 2]
        more = start + 2 < len(keys)
        out = {"Contents": [{"Key": k, "Size": len(self.files[k])} for k in page], "IsTruncated": more}
        if more:
            out["NextContinuationToken"] = str(start + 2)
        return out

    def download_file(self, Bucket, Key, Filename):
        self.downloads.append(Key)
        open(Filename, "wb").write(self.files[Key])


def r2_settings(monkeypatch, tmp_path):
    monkeypatch.setenv("R2_ENDPOINT", "https://x.r2.cloudflarestorage.com")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "a")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "b")
    monkeypatch.setenv("R2_BUCKET", "bucket")
    monkeypatch.setenv("ARTIFACT_CACHE", str(tmp_path / "cache"))
    settings_module.get_settings.cache_clear()
    return get_settings()


def test_sync_downloads_pages_then_skips_cached_files(monkeypatch, tmp_path):
    s = r2_settings(monkeypatch, tmp_path)
    s3 = FakeS3({"models/v1/clf_type.joblib": b"1234", "models/v1/labels.json": b"{}", "models/v1/sub/thresholds.json": b"{}", "models/v2/other": b"x"})
    first = r2.sync_artifacts(s, client=s3)
    assert len(first.downloaded) == 3 and first.skipped == []
    assert (tmp_path / "cache" / "models" / "sub" / "thresholds.json").read_bytes() == b"{}"
    second = r2.sync_artifacts(s, client=s3)
    assert second.downloaded == [] and len(second.skipped) == 3 and len(s3.downloads) == 3


def test_sync_with_nothing_uploaded_yet_is_a_clear_error(monkeypatch, tmp_path):
    s = r2_settings(monkeypatch, tmp_path)
    with pytest.raises(r2.ArtifactError, match="models/v1/"):
        r2.sync_artifacts(s, client=FakeS3({}))


def test_r2_not_configured_message():
    with pytest.raises(r2.ArtifactError, match="R2_ENDPOINT"):
        r2.make_client()


# ---- chunk stats ---------------------------------------------------------------


class FakePipe:
    def __init__(self, store):
        self.store, self.ops = store, []

    def hincrby(self, key, field, n):
        self.ops.append((key, field, n))

    def execute(self):
        for key, field, n in self.ops:
            self.store[key] = self.store.get(key, 0) + n


class FakeRedis:
    def __init__(self, raw=None, fail=False):
        self.counts, self.raw, self.fail, self.commands = {}, raw, fail, []

    def pipeline(self, transaction=False):
        if self.fail:
            raise ConnectionError("redis down")
        return FakePipe(self.counts)

    def execute_command(self, *args):
        self.commands.append(args)
        return self.raw


def test_bump_increments_each_ticket_once(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://x")
    settings_module.get_settings.cache_clear()
    r = FakeRedis()
    assert chunk_stats.bump_queried_count(["TKT-00001", "TKT-00002", "TKT-00001"], client=r) == 2
    assert r.counts == {"chunk:TKT-00001": 1, "chunk:TKT-00002": 1}


def test_bump_is_skipped_when_disabled_or_unconfigured_and_never_raises(monkeypatch):
    r = FakeRedis()
    monkeypatch.setenv("UPDATE_QUERIED_COUNT", "false")
    settings_module.get_settings.cache_clear()
    assert chunk_stats.bump_queried_count(["TKT-00001"], client=r) == 0 and r.counts == {}
    monkeypatch.setenv("UPDATE_QUERIED_COUNT", "true")
    settings_module.get_settings.cache_clear()
    assert chunk_stats.bump_queried_count(["TKT-00001"]) == 0  # no REDIS_URL
    assert chunk_stats.bump_queried_count(["TKT-00001"], client=FakeRedis(fail=True)) == 0


def test_top_queried_reads_documents_from_the_search_api():
    docs = [SimpleNamespace(ticket_id=b"TKT-00007", queue=b"IT Support", subject=b"VPN down", queried_count=b"12"),
            SimpleNamespace(ticket_id="TKT-00003", queue="Billing", subject="", queried_count="4")]
    seen = []

    class Ft:
        def search(self, query):
            seen.append(query.query_string())
            return SimpleNamespace(docs=docs)

    r = SimpleNamespace(ft=lambda index: Ft())
    assert chunk_stats.top_queried(10, client=r) == [
        {"ticket_id": "TKT-00007", "queue": "IT Support", "subject": "VPN down", "count": 12},
        {"ticket_id": "TKT-00003", "queue": "Billing", "subject": "", "count": 4},
    ]
    assert seen == ["@queried_count:[1 +inf]"]
    assert chunk_stats.top_queried(10) == []  # not configured


def test_generation_deadline_is_never_under_the_api_minimum(monkeypatch):
    from types import SimpleNamespace

    from engine.app.generate.prompt import DraftOut

    seen = []

    class Models(FakeModels):
        def generate_content(self, model, contents, config):
            seen.append(config.http_options.timeout)
            return super().generate_content(model, contents, config)

    c = client(monkeypatch, Models(text='{"reply": "x"}'), LLM_TIMEOUT_S="8")
    c.generate_json("p", DraftOut)
    c.generate_json("p", DraftOut, timeout_s=3)
    assert seen == [10000, 10000]
