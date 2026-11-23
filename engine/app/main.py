"""TriageAI triage engine (FastAPI). Private: only the Go gateway calls it.

Run from the repo root (single worker, because the burst detector keeps state in memory):

    uvicorn engine.app.main:app --port 8000 --workers 1
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import BackgroundTasks, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from engine.app import pipeline, related
from engine.app.common import chunk_stats, r2, ticket_store
from engine.app.schemas import CONTRACT_VERSION, EngineHealth, EngineTriageRequest, EngineTriageResponse, ErrorResponse
from engine.app.settings import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("sentineldesk.engine")

# Filled at startup. "unknown" = not configured, "ok" = loaded, "down" = configured but failed.
_artifacts: dict[str, Any] = {"status": "unknown", "detail": "not synced"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    s = get_settings()
    if s.sync_artifacts and s.r2_configured:
        try:
            report = r2.sync_artifacts(s)
            _artifacts.update(status="ok", detail=f"{s.artifact_version}: {report.total} file(s)")
        except r2.ArtifactError as exc:
            log.error("artifact sync failed: %s", exc)
            _artifacts.update(status="down", detail=str(exc))
    else:
        _artifacts.update(status="unknown", detail="R2 not configured or SYNC_ARTIFACTS=false")
    if s.redis_url and s.embedding_provider():
        from engine.app import stages_live

        pipeline.use_live_stages()
        stages_live.apply_thresholds()  # loads the trained classifier when present
        log.info("live stages enabled: embeddings=%s, generation=%s", s.embedding_provider(), s.generation_providers() or "none")
    yield


app = FastAPI(
    title="TriageAI engine",
    version=CONTRACT_VERSION,
    description="Private triage engine. Contract: contracts/README.md",
    lifespan=lifespan,
)


def _error(status: int, code: str, message: str, request_id: str | None = None) -> JSONResponse:
    body = ErrorResponse.model_validate({"error": {"code": code, "message": message, "request_id": request_id}})
    return JSONResponse(status_code=status, content=body.model_dump())


@app.exception_handler(RequestValidationError)
async def _on_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    errors = exc.errors()
    first = errors[0] if errors else {}
    if first.get("type") == "json_invalid":
        return _error(400, "INVALID_JSON", "The request body is not valid JSON.")
    loc = tuple(first.get("loc", ()))
    if loc and loc[0] == "body":  # FastAPI prefixes the request part; keep the field path
        loc = loc[1:]
    where = ".".join(str(p) for p in loc)
    msg = first.get("msg", "Invalid request.")
    return _error(422, "VALIDATION_ERROR", f"{where}: {msg}" if where else msg)


@app.exception_handler(pipeline.ContractViolation)
async def _on_contract_violation(_: Request, exc: pipeline.ContractViolation) -> JSONResponse:
    return _error(500, "INTERNAL", str(exc))


@app.exception_handler(Exception)
async def _on_unexpected(_: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error")
    return _error(500, "INTERNAL", "The engine hit an unexpected error. Check the engine logs.")


_redis_cache: tuple[float, str] = (0.0, "unknown")


def _vector_db_status() -> str:
    """Ping Redis, cached for 5 s so health checks stay cheap."""
    global _redis_cache
    checked, status = _redis_cache
    if time.monotonic() - checked < 5:
        return status
    client = chunk_stats.get_redis()
    if client is None:
        status = "unknown"
    else:
        try:
            client.ping()
            status = "ok"
        except Exception:  # noqa: BLE001
            status = "down"
    _redis_cache = (time.monotonic(), status)
    return status


def _components() -> dict[str, str]:
    s = get_settings()
    return {
        "vector_db": _vector_db_status(),
        "llm": "ok" if s.llm_configured else "down",
        "artifacts": _artifacts["status"],
    }


@app.get("/healthz", response_model=EngineHealth)
def healthz() -> EngineHealth:
    stages = pipeline.stage_status()
    components = _components()
    degraded = "stub" in stages.values() or "down" in components.values()
    return EngineHealth(
        status="degraded" if degraded else "ok",
        contract_version=CONTRACT_VERSION,
        stages=stages,
        components=components,
    )


@app.get("/readyz")
def readyz() -> JSONResponse:
    """Ready when the process is up and artifacts did not fail to load. Deploy scripts wait on this."""
    ready = _artifacts["status"] != "down"
    return JSONResponse(status_code=200 if ready else 503, content={"ready": ready, "artifacts": _artifacts["detail"]})


@app.post(
    "/v1/triage",
    response_model=EngineTriageResponse,
    responses={400: {"model": ErrorResponse}, 422: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
def triage(req: EngineTriageRequest, background: BackgroundTasks) -> EngineTriageResponse:
    resp = pipeline.run_triage(req)
    if resp.precedents:
        background.add_task(chunk_stats.bump_queried_count, [p.ticket_id for p in resp.precedents])
    background.add_task(ticket_store.save, resp.model_dump(mode="json", by_alias=True))
    if not pipeline.is_demo_ticket(resp.ticket_id):  # drills and lab tests don't need customer readings
        background.add_task(related.prefetch, resp.ticket_id)
    return resp


# ---- shared ticket store: creators submit, managers resolve -------------------------------


class StatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str


def _store_call(fn, *args):
    try:
        return fn(*args)
    except ticket_store.StoreUnavailable as exc:
        return _error(503, "ENGINE_UNAVAILABLE", str(exc))


@app.get("/v1/tickets")
def list_tickets(limit: int = Query(200, ge=1, le=2000)) -> JSONResponse:
    out = _store_call(ticket_store.recent, limit)
    return out if isinstance(out, JSONResponse) else JSONResponse(content={"items": out})


@app.get("/v1/tickets/{ticket_id}/status")
def ticket_status(ticket_id: str) -> JSONResponse:
    out = _store_call(ticket_store.status_view, ticket_id)
    if isinstance(out, JSONResponse):
        return out
    return JSONResponse(content=out) if out else _error(404, "NOT_FOUND", "No ticket with that id (tickets are kept for 7 days).")


NOT_FOUND_MSG = "No ticket with that id (tickets are kept for 7 days)."


@app.get("/v1/tickets/{ticket_id}")
def ticket_creator_view(ticket_id: str) -> JSONResponse:
    """The creator's plain view of their ticket: their words, language, status and dates. No analytics."""
    out = _store_call(ticket_store.creator_view, ticket_id)
    if isinstance(out, JSONResponse):
        return out
    return JSONResponse(content=out) if out else _error(404, "NOT_FOUND", NOT_FOUND_MSG)


@app.get("/v1/tickets/{ticket_id}/related")
def ticket_related(ticket_id: str) -> JSONResponse:
    """Similar solved tickets as suggested reading, translated into the creator's language when needed."""
    out = _store_call(related.related_for, ticket_id)
    if isinstance(out, JSONResponse):
        return out
    if not out:
        return _error(404, "NOT_FOUND", NOT_FOUND_MSG)
    return JSONResponse(content={k: v for k, v in out.items() if k != "complete"})


@app.put("/v1/tickets/{ticket_id}/status")
def update_ticket_status(ticket_id: str, body: StatusUpdate) -> JSONResponse:
    try:
        out = _store_call(ticket_store.set_status, ticket_id, body.status)
    except ValueError as exc:
        return _error(422, "VALIDATION_ERROR", f"status: {exc}")
    if isinstance(out, JSONResponse):
        return out
    return JSONResponse(content=out) if out else _error(404, "NOT_FOUND", "No ticket with that id (tickets are kept for 7 days).")


@app.get("/v1/chunks/top-queried")
def top_queried(limit: int = Query(20, ge=1, le=100)) -> JSONResponse:
    try:
        return JSONResponse(content={"items": chunk_stats.top_queried(limit)})
    except Exception as exc:  # noqa: BLE001 - index may not exist yet
        return _error(503, "ENGINE_UNAVAILABLE", f"Could not read chunk statistics: {type(exc).__name__}")
