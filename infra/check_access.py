"""Check that this machine can reach Gemini, Cloudflare R2 and Redis with the keys in .env.

    python infra/check_access.py

Run from anywhere; it reads .env from the repo root. Prints one line per service and
never prints a secret. Exits with 1 when a check fails, 0 when everything passed or was
skipped.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Skip(Exception):
    """The check can't run yet (missing setting or package)."""


def load_env(path: Path) -> bool:
    if not path.exists():
        return False
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.split(" #", 1)[0].strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)
    return True


def need(*names: str) -> None:
    missing = [n for n in names if not os.environ.get(n) or "<" in os.environ[n]]
    if missing:
        raise Skip(f"set {', '.join(missing)} in .env")


def check_openai() -> str:
    need("OPENAI_API_KEY")
    try:
        import openai
    except ImportError as exc:
        raise Skip("pip install openai") from exc
    dim = int(os.environ.get("EMBED_DIM", "768"))
    client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=20)
    model = os.environ.get("OPENAI_EMBED_MODEL") or "text-embedding-3-small"
    got = len(client.embeddings.create(model=model, input=["ping"], dimensions=dim).data[0].embedding)
    if got != dim:
        raise RuntimeError(f"expected a {dim}-dim vector, got {got}")
    return f"{model} returned a {got}-dim vector (preferred provider)"


def check_gemini() -> str:
    os.environ.setdefault("EMBED_MODEL", "gemini-embedding-2")
    need("GEMINI_API_KEY", "EMBED_MODEL")
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise Skip("pip install google-genai") from exc
    dim = int(os.environ.get("EMBED_DIM", "768"))
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    result = client.models.embed_content(
        model=os.environ["EMBED_MODEL"],
        contents=["ping"],
        config=types.EmbedContentConfig(output_dimensionality=dim),
    )
    got = len(result.embeddings[0].values)
    if got != dim:
        raise RuntimeError(f"expected a {dim}-dim vector, got {got}")
    return f"{os.environ['EMBED_MODEL']} returned a {got}-dim vector"


def check_r2() -> str:
    need("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
    try:
        import boto3
    except ImportError as exc:
        raise Skip("pip install boto3") from exc
    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    page = s3.list_objects_v2(Bucket=bucket, MaxKeys=5)
    return f"bucket {bucket} is reachable ({page.get('KeyCount', 0)} object(s) on the first page)"


def check_redis() -> str:
    need("REDIS_URL")
    try:
        import redis
    except ImportError as exc:
        raise Skip("pip install redis") from exc
    client = redis.Redis.from_url(os.environ["REDIS_URL"], socket_connect_timeout=3)
    client.ping()
    try:
        client.execute_command("FT._LIST")
    except redis.ResponseError as exc:
        raise RuntimeError("connected, but the Query Engine (FT.*) is missing; use the redis/redis-stack image") from exc
    return "ping ok, Query Engine available"


def main() -> int:
    if not load_env(ROOT / ".env"):
        print("No .env in the repo root. Copy infra/env.template to .env and fill it in.\n")
    failed = False
    for name, check in (("OpenAI", check_openai), ("Gemini", check_gemini), ("R2", check_r2), ("Redis", check_redis)):
        try:
            print(f"OK    {name:<7}{check()}")
        except Skip as skip:
            print(f"SKIP  {name:<7}{skip}")
        except Exception as exc:  # noqa: BLE001 - report every failure, keep checking
            failed = True
            print(f"FAIL  {name:<7}{type(exc).__name__}: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
