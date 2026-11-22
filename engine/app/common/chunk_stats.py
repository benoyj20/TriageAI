"""queried_count tracking and the most-queried endpoint (task H-17).

Each time a chunk is returned as a precedent, ``HINCRBY chunk:<id> queried_count 1``.
It is telemetry for the Insights tab. It never affects ranking, and the evaluation runs
with UPDATE_QUERIED_COUNT=false so it can't change the index.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from engine.app.settings import Settings, get_settings

log = logging.getLogger("sentineldesk.chunk_stats")

_redis: Any = None
_lock = threading.Lock()


def get_redis(settings: Settings | None = None) -> Any | None:
    """Shared Redis client, or None when REDIS_URL is not set. Short timeouts: never stall a request."""
    global _redis
    s = settings or get_settings()
    if not s.redis_url:
        return None
    with _lock:
        if _redis is None:
            import redis

            _redis = redis.Redis.from_url(s.redis_url, socket_connect_timeout=1, socket_timeout=2)
        return _redis


def set_redis(client: Any | None) -> None:
    global _redis
    with _lock:
        _redis = client


def bump_queried_count(ticket_ids: list[str], settings: Settings | None = None, client: Any = None) -> int:
    """Add 1 to queried_count for each ticket, pipelined. Returns how many were bumped (0 on any failure)."""
    s = settings or get_settings()
    ids = list(dict.fromkeys(ticket_ids))
    if not ids or not s.update_queried_count:
        return 0
    client = client or get_redis(s)
    if client is None:
        return 0
    try:
        pipe = client.pipeline(transaction=False)
        for tid in ids:
            pipe.hincrby(f"{s.redis_chunk_prefix}{tid}", "queried_count", 1)
        pipe.execute()
        return len(ids)
    except Exception as exc:  # noqa: BLE001 - telemetry must never break a request
        log.warning("queried_count update failed: %s: %s", type(exc).__name__, exc)
        return 0


def _text(v: Any) -> str:
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)


def top_queried(limit: int = 20, settings: Settings | None = None, client: Any = None) -> list[dict[str, Any]]:
    """The most-returned chunks, for the Insights charts."""
    from redis.commands.search.query import Query

    s = settings or get_settings()
    client = client or get_redis(s)
    if client is None:
        return []
    limit = max(1, min(limit, 100))
    query = Query("@queried_count:[1 +inf]").sort_by("queried_count", asc=False).paging(0, limit).dialect(2)
    rows = []
    for doc in client.ft(s.redis_chunk_index).search(query).docs:
        rows.append(
            {
                "ticket_id": _text(getattr(doc, "ticket_id", "")),
                "queue": _text(getattr(doc, "queue", "")),
                "subject": _text(getattr(doc, "subject", "")),
                "count": int(float(_text(getattr(doc, "queried_count", 0)) or 0)),
            }
        )
    return rows
