"""Server package — FastAPI app + middleware + routes.

Endpoint surface (Week 1 skeleton):

- `GET  /healthz` — liveness; returns adapter health + service identity.
- `GET  /health`  — backward-compat alias of `/healthz`.
- `POST /api/ai/jobs` — submit an AI research job (returns in <2s with a
  job id, mirroring ARCHITECTURE §七 "POST /api/ai-research").
- `GET  /api/ai/jobs/{job_id}` — read job status (current_step,
  sources count, cost snapshot). Mirrors "GET /api/ai-research/{id}/status".
- `POST /api/ai/jobs/{job_id}/cancel` — cancel a queued or running job.

Week 5 will:
- Persist jobs via the DB-backed store (`JOB_RUNNER_BACKEND=db`).
- Trigger the runner asynchronously after submit.
- Wire idempotency + budget checks before submission.

In Week 1 we run jobs **synchronously after submit** against the
in-memory store so the HTTP contract is exercisable end-to-end. The
request returns the final `RunOutcome` shape so the BFF can already
render it; this trades a slow response for a complete Week 1 skeleton.
This trade-off is documented as ADR 0004 #3 in the spike report.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, Any

import structlog
from fastapi import Depends, FastAPI, HTTPException, Path, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ai_engine.adapters.base import ResearchEngineAdapter, build_adapter
from ai_engine.adapters.fake import FakeAdapter
from ai_engine.contracts.errors import AdapterError, ERROR_CODES, HTTP_STATUS
from ai_engine.contracts.states import (
    AI_JOB_STATUS,
    CREATION_METHOD,
    REPORT_TYPE,
    SOURCE_POLICY,
    ReportType,
    SourcePolicy,
)
from ai_engine.job_runner.runner import run_one_available_job
from ai_engine.job_runner.store import (
    InMemoryJobStore,
    build_store,
    make_job_snapshot,
)

logger = logging.getLogger("ai_engine.server")
structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
)


# ──────────────────────────────────────────────────────────────────────
# App factory
# ──────────────────────────────────────────────────────────────────────


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    structlog.get_logger("ai_engine.server").info(
        "ai-engine.boot",
        extra={"adapter": os.environ.get("AI_ENGINE_ADAPTER", "fake")},
    )
    yield
    structlog.get_logger("ai_engine.server").info("ai-engine.shutdown")


import os  # noqa: E402  (kept here to keep import block visually grouped)

app = FastAPI(
    title="Deep Research AI Engine",
    version="0.1.0",
    lifespan=_lifespan,
)


# ──────────────────────────────────────────────────────────────────────
# Middleware: request_id + structured access log
# ──────────────────────────────────────────────────────────────────────


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = request_id
    log = structlog.get_logger("ai_engine.http")
    started = asyncio.get_event_loop().time()
    try:
        response = await call_next(request)
    except AdapterError as exc:
        elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
        log.error(
            "ai-engine.error",
            request_id=request_id,
            route=request.url.path,
            method=request.method,
            latency_ms=elapsed_ms,
            error_code=exc.code,
            error_message=exc.message,
        )
        return _error_response(exc, request_id)
    except Exception:  # pragma: no cover — defensive
        elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
        log.exception(
            "ai-engine.unhandled",
            request_id=request_id,
            route=request.url.path,
            latency_ms=elapsed_ms,
        )
        return JSONResponse(
            status_code=500,
            content={
                "code": "INTERNAL",
                "message": "internal server error",
                "requestId": request_id,
            },
        )
    elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
    log.info(
        "ai-engine.request",
        request_id=request_id,
        route=request.url.path,
        method=request.method,
        status=response.status_code,
        latency_ms=elapsed_ms,
    )
    # Surface the request_id on every response so the BFF can correlate.
    response.headers["x-request-id"] = request_id
    return response


def _error_response(exc: AdapterError, request_id: str) -> JSONResponse:
    payload: dict[str, Any] = {
        "code": exc.code,
        "message": exc.message,
        "requestId": request_id,
    }
    if exc.details is not None:
        payload["details"] = exc.details
    return JSONResponse(status_code=exc.http_status, content=payload)


# ──────────────────────────────────────────────────────────────────────
# Singletons (Week 1 in-memory)
# ──────────────────────────────────────────────────────────────────────


def _store_singleton() -> InMemoryJobStore:
    """Lazy singleton; tests can override via `app.dependency_overrides`."""
    store = build_store()
    assert isinstance(store, InMemoryJobStore)  # Week 1 default
    return store


def _adapter_singleton() -> ResearchEngineAdapter:
    """Return whatever `build_adapter()` produces."""
    adapter = build_adapter()
    # The `claude`/`gpt_researcher` factories raise before returning, so the
    # only thing that comes back here conforms to the Protocol.
    return adapter


# ──────────────────────────────────────────────────────────────────────
# Request/Response models
# ──────────────────────────────────────────────────────────────────────


class SubmitAiJobBody(BaseModel):
    """Mirrors `packages/shared/src/schemas.ts CreateAiJobInput`.

    Validated via Pydantic instead of Zod to keep the engine self-contained.
    The Web BFF still validates first; this is defence-in-depth.
    """

    job_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    requester_id: str = Field(default="00000000-0000-0000-0000-000000000001")
    topic: str = Field(min_length=2, max_length=200)
    context: str | None = Field(default=None, max_length=2000)
    report_type: ReportType = Field(default="research_report")
    source_policy: SourcePolicy = Field(default="prefer_user_sources")
    source_refs: list[dict[str, str | bool]] = Field(default_factory=list, max_length=10)


class SubmitAiJobResponse(BaseModel):
    job_id: str
    status: str
    final_status: str | None = None
    current_step: str | None = None
    sources_count: int = 0
    token_input_total: int = 0
    token_output_total: int = 0
    cost_cents: int = 0
    search_count: int = 0
    error_code: str | None = None
    error_message: str | None = None
    request_id: str | None = None


class CancelAiJobResponse(BaseModel):
    job_id: str
    was_queued: bool
    was_running: bool


class HealthResponse(BaseModel):
    status: str
    adapter: str
    jobs_in_memory: int
    request_id: str


# ──────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────


@app.get("/health")
async def health_alias(
    request: Request,
    store: Annotated[InMemoryJobStore, Depends(_store_singleton)],
) -> dict[str, str]:
    return await _health_payload(request, store)


@app.get("/healthz")
async def healthz(
    request: Request,
    store: Annotated[InMemoryJobStore, Depends(_store_singleton)],
) -> dict[str, str]:
    return await _health_payload(request, store)


async def _health_payload(request: Request, store: InMemoryJobStore) -> dict[str, str]:
    adapter = _adapter_singleton()
    health = await adapter.health()
    return {
        "status": "ok" if health.ok else "degraded",
        "adapter": health.adapter_name,
        "jobs_in_memory": health.details.get("jobs_in_memory", "0"),
        "request_id": getattr(request.state, "request_id", ""),
    }


@app.post(
    "/api/ai/jobs",
    response_model=SubmitAiJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_ai_job(
    body: SubmitAiJobBody,
    request: Request,
    store: Annotated[InMemoryJobStore, Depends(_store_singleton)],
) -> SubmitAiJobResponse:
    if body.source_policy == "only_user_sources" and not body.source_refs:
        raise _http_error(
            "AI_INVALID_SOURCE_POLICY",
            "only_user_sources requires at least one source_ref",
        )
    adapter = _adapter_singleton()
    # 1. Persist the snapshot so subsequent GET can find it.
    snapshot = make_job_snapshot(
        topic=body.topic,
        requester_id=body.requester_id,
        report_type=body.report_type,
        source_policy=body.source_policy,
    )
    # Override job_id with the caller-provided one (BFF-supplied uuid).
    snapshot = type(snapshot)(
        job_id=body.job_id,
        requester_id=snapshot.requester_id,
        topic=snapshot.topic,
        context=body.context,
        report_type=snapshot.report_type,
        source_policy=snapshot.source_policy,
        status=snapshot.status,
        current_step=snapshot.current_step,
        attempts=snapshot.attempts,
        idempotency_key=snapshot.idempotency_key,
        source_refs=tuple(body.source_refs),
    )
    await store.enqueue(snapshot)

    # 2. Run synchronously against the in-memory store. Week 5 will replace
    # this with an `asyncio.create_task` so the BFF can poll.
    outcome = await run_one_available_job(store=store, adapter=adapter)
    if outcome is None:
        # Shouldn't happen — we just enqueued. Defensive.
        raise _http_error("INTERNAL", "submit lost the job immediately")

    return SubmitAiJobResponse(
        job_id=outcome.job_id,
        status="completed",
        final_status=outcome.final_status,
        current_step=outcome.current_step,
        sources_count=len(outcome.sources),
        token_input_total=outcome.cost.token_input_total,
        token_output_total=outcome.cost.token_output_total,
        cost_cents=outcome.cost.cost_cents,
        search_count=outcome.cost.search_count,
        error_code=outcome.error_code,
        error_message=outcome.error_message,
        request_id=getattr(request.state, "request_id", None),
    )


@app.get("/api/ai/jobs/{job_id}", response_model=SubmitAiJobResponse)
async def get_ai_job(
    job_id: Annotated[str, Path(min_length=1)],
    request: Request,
    store: Annotated[InMemoryJobStore, Depends(_store_singleton)],
) -> SubmitAiJobResponse:
    row = store.get_row(job_id)
    if row is None:
        raise _http_error("AI_JOB_NOT_FOUND", f"job {job_id} not found")
    snap = row.snapshot
    return SubmitAiJobResponse(
        job_id=snap.job_id,
        status="stored",
        final_status=snap.status,
        current_step=snap.current_step,
        sources_count=len(row.last_sources),
        token_input_total=row.last_token_in,
        token_output_total=row.last_token_out,
        cost_cents=row.last_cost_cents,
        search_count=row.last_sources.__len__() if row.last_sources else 0,
        error_code=None,
        error_message=None,
        request_id=getattr(request.state, "request_id", None),
    )


@app.post("/api/ai/jobs/{job_id}/cancel", response_model=CancelAiJobResponse)
async def cancel_ai_job(
    job_id: Annotated[str, Path(min_length=1)],
    store: Annotated[InMemoryJobStore, Depends(_store_singleton)],
) -> CancelAiJobResponse:
    adapter = _adapter_singleton()
    try:
        outcome = await adapter.cancel(job_id)
    except AdapterError as exc:
        raise _http_error(exc.code, exc.message) from exc
    return CancelAiJobResponse(
        job_id=outcome.job_id,
        was_queued=outcome.was_queued,
        was_running=outcome.was_running,
    )


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


def _http_error(code: str, message: str) -> HTTPException:
    """Convert a contract error code into a FastAPI HTTPException."""
    if code not in ERROR_CODES:
        code = "INTERNAL"
    http_status = HTTP_STATUS.get(code, 500)
    return HTTPException(
        status_code=http_status,
        detail={"code": code, "message": message},
    )


__all__ = ["app", "build_adapter", "build_store", "FakeAdapter"]


# Quiet linter — referenced by future test files; avoid unused warning.
_ = (datetime, timezone, AI_JOB_STATUS, REPORT_TYPE, SOURCE_POLICY, CREATION_METHOD)