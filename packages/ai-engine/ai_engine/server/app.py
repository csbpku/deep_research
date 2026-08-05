"""Server package — FastAPI app + middleware + routes.

Endpoint surface (Week 2):

- `GET  /healthz` — liveness; returns adapter health + service identity.
- `GET  /health`  — backward-compat alias of `/healthz`.
- `POST /api/ai/jobs` — submit an AI research job; returns 202 within 2s
  with a job id and `status="queued"`. Client polls `GET /api/ai/jobs/{id}`
  every 5s for `current_step` / `final_status` / cost. Mirrors
  ARCHITECTURE §七 "POST /api/ai-research".
- `GET  /api/ai/jobs/{job_id}` — read job status.
- `POST /api/ai/jobs/{job_id}/cancel` — cancel a queued or running job.

Week 1 review 修正：原版在 HTTP 请求内 `await run_one_available_job(...)`,
真实 LLM 接入后时延可达 5 分钟，会把 HTTP 连接耗尽。Week 2 起改 fire-and-forget
后台 task，HTTP 立即返回 202 + queued。Runner 真实 DB 接入留到 Week 2 runner
（实施计划 §四 160 行：PostgreSQL shared runner）。
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, cast
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import structlog
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Path, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ai_engine.adapters.base import AdapterSource, ResearchEngineAdapter, build_adapter
from ai_engine.adapters.fake import FakeAdapter
from ai_engine.contracts.errors import AdapterError, ERROR_CODES, HTTP_STATUS
from ai_engine.contracts.states import (
    AI_JOB_STATUS,
    CREATION_METHOD,
    REPORT_TYPE,
    SOURCE_POLICY,
    AiJobStatus,
    ReportType,
    SourcePolicy,
)
from ai_engine.job_runner.runner import run_one_available_job
from ai_engine.job_runner.store import (
    JobStore,
    build_store,
    make_job_snapshot,
)
from ai_engine.job_runner.models import JobSnapshot

load_dotenv()

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
async def _lifespan(app_instance: FastAPI) -> AsyncIterator[None]:
    structlog.get_logger("ai_engine.server").info(
        "ai-engine.boot",
        extra={"adapter": os.environ.get("AI_ENGINE_ADAPTER", "gpt_researcher")},
    )
    # W2 review 修正:process-level store singleton,所有 endpoint / 后台
    # task 共享同一个 instance。否则每次请求新建,POST 写进去的 job 在
    # 下一个 GET 不可见。lifespan 创建并绑定到 app.state.job_store。
    store = build_store()
    app_instance.state.job_store = store
    # Start the process-level DB pool once. Radar routes and the share
    # submission worker reuse this pool; HTTP handlers only enqueue work.
    from ai_engine.job_runner.db_store import DbJobStore
    share_worker_task: asyncio.Task[None] | None = None
    ai_job_worker_task: asyncio.Task[None] | None = None
    import_worker_task: asyncio.Task[None] | None = None
    radar_daily_task: asyncio.Task[None] | None = None
    submission_task: asyncio.Task[None] | None = None
    topic_agg_task: asyncio.Task[None] | None = None
    topic_synth_task: asyncio.Task[None] | None = None
    # asyncio tasks can start immediately, so publish the adapter before any
    # worker reads app.state.adapter.
    app_instance.state.adapter = build_adapter()
    if isinstance(store, DbJobStore):
        await store.open()
        app_instance.state.db_pool = store.pool
        app_instance.state.radar_sync_lock = asyncio.Lock()
        await store.start_reaper()
        if os.environ.get("SHARE_WORKER_ENABLED", "1") == "1":
            share_worker_task = asyncio.create_task(
                _share_submission_worker_loop(app_instance),
                name="share-submission-worker",
            )
        if os.environ.get("AI_JOB_WORKER_ENABLED", "1") == "1":
            ai_job_worker_task = asyncio.create_task(
                _ai_job_worker_loop(app_instance),
                name="ai-job-worker",
            )
        if os.environ.get("IMPORT_WORKER_ENABLED", "1") == "1":
            import_worker_task = asyncio.create_task(
                _import_worker_loop(),
                name="content-import-worker",
            )
        if os.environ.get("RADAR_DAILY_CRON_ENABLED", "1") == "1":
            radar_daily_task = asyncio.create_task(
                _radar_daily_loop(app_instance),
                name="radar-daily-cron",
            )
        # P1-B: submission worker
        if os.environ.get("SUBMISSION_WORKER_ENABLED", "1") == "1":
            submission_task = asyncio.create_task(
                _submission_worker_loop(app_instance),
                name="radar-submission-worker",
            )
        # P1-D: topic aggregation (cron @ 02:00 Asia/Shanghai) + topic synthesis (every 5 min)
        if os.environ.get("TOPIC_AGGREGATION_ENABLED", "1") == "1":
            topic_agg_task = asyncio.create_task(
                _topic_aggregation_loop(app_instance),
                name="radar-topic-aggregator",
            )
        if os.environ.get("TOPIC_SYNTHESIS_ENABLED", "1") == "1":
            topic_synth_task = asyncio.create_task(
                _topic_synthesis_loop(app_instance),
                name="radar-topic-synthesis",
            )
    try:
        yield
    finally:
        if share_worker_task is not None:
            share_worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await share_worker_task
        if ai_job_worker_task is not None:
            ai_job_worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await ai_job_worker_task
        if import_worker_task is not None:
            import_worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await import_worker_task
        if radar_daily_task is not None:
            radar_daily_task.cancel()
            with suppress(asyncio.CancelledError):
                await radar_daily_task
        if submission_task is not None:
            submission_task.cancel()
            with suppress(asyncio.CancelledError):
                await submission_task
        if topic_agg_task is not None:
            topic_agg_task.cancel()
            with suppress(asyncio.CancelledError):
                await topic_agg_task
        if topic_synth_task is not None:
            topic_synth_task.cancel()
            with suppress(asyncio.CancelledError):
                await topic_synth_task
        if isinstance(store, DbJobStore):
            await store.close()
    structlog.get_logger("ai_engine.server").info("ai-engine.shutdown")


import os  # noqa: E402  (kept here to keep import block visually grouped)


async def _share_submission_worker_loop(app_instance: FastAPI) -> None:
    """Poll frozen share_submissions without blocking request handlers."""
    from ai_engine.share_submission_worker import run_one_share_submission

    while True:
        try:
            result = await run_one_share_submission(
                app_instance.state.db_pool,
                app_instance.state.adapter,
                worker_id=f"share-{os.getpid()}",
            )
            if result is None:
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            structlog.get_logger("ai_engine.share_submission").error(
                "ai-engine.share_submission.loop_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(1.0)


async def _ai_job_worker_loop(app_instance: FastAPI) -> None:
    """Poll ai_research_jobs every 1s, acquire+run one job at a time.

    Mirrors share_submission loop — single acquire+run per iteration;
    returns after each job so failures never block the entire queue.
    """
    store: JobStore = app_instance.state.job_store
    adapter: ResearchEngineAdapter = app_instance.state.adapter
    logger = structlog.get_logger("ai_engine.worker")
    wid = f"ai-worker-{os.getpid()}"
    while True:
        try:
            await store.open()
            outcome = await run_one_available_job(
                store=store,
                adapter=adapter,
                worker_id=wid,
                draft_factory=_make_draft_factory(store),
            )
            if outcome is None:
                await asyncio.sleep(1.0)
            else:
                logger.info(
                    "ai-engine.worker.done",
                    job_id=outcome.job_id,
                    final_status=outcome.final_status,
                    cost_cents=outcome.cost.cost_cents,
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("ai-engine.worker.loop_failed", exc_info=True)
            await asyncio.sleep(1.0)


async def _import_worker_loop() -> None:
    """Continuously consume content_import_jobs with a dedicated DB store."""
    from ai_engine.import_worker import run_one_import_job
    from ai_engine.job_runner.db_store import IMPORT_TABLE, DbJobStore

    log = structlog.get_logger("ai_engine.import_worker")
    poll_seconds = float(os.environ.get("IMPORT_WORKER_POLL_SECONDS", "1"))
    store = DbJobStore(table_name=IMPORT_TABLE)
    try:
        await store.open()
        await store.start_reaper()
        while True:
            try:
                job_id = await run_one_import_job(
                    store,
                    worker_id=f"import-{os.getpid()}",
                )
                if job_id is None:
                    await asyncio.sleep(poll_seconds)
                else:
                    log.info("ai-engine.import_worker.done", job_id=job_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("ai-engine.import_worker.loop_failed", exc_info=True)
                await asyncio.sleep(poll_seconds)
    finally:
        await store.close()


def _seconds_until_next_radar_window(
    schedule: str,
    tz: ZoneInfo,
    *,
    now: datetime | None = None,
) -> float:
    """Seconds until the next daily HH:MM window in ``tz`` (Asia/Shanghai)."""
    try:
        hour_s, _, minute_s = schedule.partition(":")
        hour = int(hour_s)
        minute = int(minute_s)
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError
    except ValueError:
        hour, minute = 8, 0
    now = now or datetime.now(tz)
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def _radar_daily_loop(app_instance: FastAPI) -> None:
    """Daily radar pipeline: sync → enrichment → digest at 08:00 Asia/Shanghai.

    Controlled by ``RADAR_DAILY_CRON_ENABLED`` (default 1 when a real DB pool
    is present) and ``RADAR_DAILY_CRON_TIME`` (default "08:00"). The shared
    ``radar_sync_lock`` prevents overlap with an admin-triggered sync.
    """
    from ai_engine.radar.sync_endpoint import run_radar_daily_job

    log = structlog.get_logger("ai_engine.radar")
    schedule = os.environ.get("RADAR_DAILY_CRON_TIME", "08:00")
    tz = ZoneInfo("Asia/Shanghai")
    while True:
        try:
            await asyncio.sleep(_seconds_until_next_radar_window(schedule, tz))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.daily_schedule_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(3600.0)
            continue
        try:
            await run_radar_daily_job(
                pool=app_instance.state.db_pool,
                adapter=app_instance.state.adapter,
                triggered_by="cron",
                request_id=f"cron-{uuid.uuid4()}",
                lock=getattr(app_instance.state, "radar_sync_lock", None),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.daily_job_failed",
                error_type=type(exc).__name__,
            )


# ──────────────────────────────────────────────────────────────────────
# P1-B / P1-D 进程内 worker loop
# ──────────────────────────────────────────────────────────────────────


async def _submission_worker_loop(app_instance: FastAPI) -> None:
    """P1-B: 持续消费 radar_submissions 行的状态推进。
    失败隔离：worker 抛任何异常都不会让 loop 退出。
    """
    from ai_engine.radar.submission_worker import run_submission_worker

    log = structlog.get_logger("ai_engine.radar.submission")
    poll_seconds = float(os.environ.get("SUBMISSION_WORKER_POLL_SECONDS", "2"))
    while True:
        try:
            processed = await run_submission_worker(
                app_instance.state.db_pool,
                max_iterations=int(os.environ.get("SUBMISSION_WORKER_ITERATIONS", "1")),
            )
            if processed == 0:
                await asyncio.sleep(poll_seconds)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.submission.loop_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(poll_seconds)


def _seconds_until_next_topic_window(schedule: str, tz: ZoneInfo) -> float:
    """Topic 聚合窗口：默认 02:00 Asia/Shanghai。复用 radar daily 风格。"""
    return _seconds_until_next_radar_window(schedule, tz)


async def _topic_aggregation_loop(app_instance: FastAPI) -> None:
    """P1-D: 每日一次主题聚合（默认 02:00 Asia/Shanghai）。"""
    from ai_engine.radar.topic_aggregation_worker import run_topic_aggregation

    log = structlog.get_logger("ai_engine.radar.topic_agg")
    schedule = os.environ.get("TOPIC_AGGREGATION_CRON_TIME", "02:00")
    tz = ZoneInfo("Asia/Shanghai")
    while True:
        try:
            await asyncio.sleep(_seconds_until_next_topic_window(schedule, tz))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.topic_agg.schedule_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(3600.0)
            continue
        try:
            await run_topic_aggregation(app_instance.state.db_pool)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.topic_agg.run_failed",
                error_type=type(exc).__name__,
            )


async def _topic_synthesis_loop(app_instance: FastAPI) -> None:
    """P1-D: 每 5 分钟跑一次主题 AI 综述（默认）。"""
    from ai_engine.radar.topic_synthesis_worker import run_topic_synthesis

    log = structlog.get_logger("ai_engine.radar.topic_synth")
    interval = float(os.environ.get("TOPIC_SYNTHESIS_INTERVAL_SECONDS", "300"))
    while True:
        try:
            await asyncio.sleep(interval)
            await run_topic_synthesis(app_instance.state.db_pool)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.topic_synth.loop_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(interval)


app = FastAPI(
    title="Deep Research AI Engine",
    version="0.1.0",
    lifespan=_lifespan,
)

from ai_engine.radar.sync_endpoint import router as radar_router  # noqa: E402
from ai_engine.radar.topic_endpoint import router as topic_router  # noqa: E402
from ai_engine.server.chat import router as chat_router  # noqa: E402

app.include_router(radar_router)
app.include_router(topic_router)
app.include_router(chat_router)


# ──────────────────────────────────────────────────────────────────────
# Middleware: request_id + structured access log
# ──────────────────────────────────────────────────────────────────────


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = request_id
    try:
        log = structlog.get_logger("ai_engine.http")
    except Exception:  # pragma: no cover - third-party logging configuration
        log = None
    started = asyncio.get_event_loop().time()
    try:
        response = await call_next(request)
    except AdapterError as exc:
        elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
        _safe_structlog(
            log,
            "error",
            "ai-engine.error",
            request_id=request_id,
            route=request.url.path,
            method=request.method,
            latency_ms=elapsed_ms,
            error_code=exc.code,
            error_message=exc.message,
        )
        return _error_response(exc, request_id)
    except Exception as exc:  # pragma: no cover — defensive
        elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
        _safe_structlog(
            log,
            "exception",
            "ai-engine.unhandled",
            request_id=request_id,
            route=request.url.path,
            latency_ms=elapsed_ms,
        )
        # Week 1 review 修正:structlog JSONRenderer 配 exc_info 时,
        # format_exc_info processor 没在 chain 里,异常 stack 不进 JSON。
        # 用 traceback 显式打 stderr,运维 grep 能直接定位。
        import traceback as _tb
        print(f"[UNHANDLED {request_id}] {type(exc).__name__}: {exc}", file=__import__('sys').stderr)
        _tb.print_exception(type(exc), exc, exc.__traceback__, file=__import__('sys').stderr)
        return JSONResponse(
            status_code=500,
            content={
                "code": "INTERNAL",
                "message": "internal server error",
                "requestId": request_id,
            },
        )
    elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
    # Access logging happens after the handler has produced a response. A
    # third-party research dependency may reconfigure structlog at runtime;
    # logging must never turn an otherwise valid response into Starlette's
    # plain-text ``500 Internal Server Error``.
    _safe_structlog(
        log,
        "info",
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


def _safe_structlog(log: Any, method_name: str, event: str, **kwargs: Any) -> None:
    """Emit a structured log without allowing logging failures into HTTP."""
    if log is None:
        return
    try:
        getattr(log, method_name)(event, **kwargs)
    except Exception:  # pragma: no cover - logging is best-effort by design
        with suppress(Exception):
            logger.exception("structured logging failed for %s", event)


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


def _store_singleton() -> JobStore:
    """返回 process-level store。

    W2 review 修正:之前的 `assert isinstance(store, InMemoryJobStore)` 把
    DbJobStore 拒之门外,即使 JOB_RUNNER_BACKEND=db 也立刻挂。

    Resolve 顺序:
    1. FastAPI dependency_overrides[_store_singleton] (测试注入) — 优先;
    2. app.state.job_store (lifespan 创建,生产路径);
    3. build_store() lazy fallback (dev 启动未经过 lifespan)。

    共享单例,否则 POST 写进去 GET 看不见。
    """
    # 1. 测试 override
    override = app.dependency_overrides.get(_store_singleton)
    if override is not None:
        return cast(JobStore, override())
    # 2. lifespan 创建
    state_store = getattr(app.state, "job_store", None)
    if state_store is not None:
        return cast(JobStore, state_store)
    # 3. lazy fallback
    store = build_store()
    app.state.job_store = store
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

    W6: 加 `idempotency_key` 字段 —— BFF 把客户端 `Idempotency-Key` header
    透传到这里;同一 (requester_id, key) 二次提交返回原 job,不再 enqueue 也不扣 quota。
    """

    job_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    requester_id: str = Field(default="00000000-0000-0000-0000-000000000001")
    topic: str = Field(min_length=2, max_length=200)
    context: str | None = Field(default=None, max_length=2000)
    report_type: ReportType = Field(default="research_report")
    source_policy: SourcePolicy = Field(default="prefer_user_sources")
    source_refs: list[dict[str, str | bool]] = Field(default_factory=list, max_length=10)
    idempotency_key: str | None = Field(default=None, max_length=64)


class SubmitAiJobResponse(BaseModel):
    job_id: str
    status: str
    topic: str | None = None
    final_status: str | None = None
    current_step: str | None = None
    sources_count: int = 0
    partial_sources_count: int = 0
    failed_sources_count: int = 0
    error_stage: str | None = None
    draft_research_id: str | None = None
    report_type: str | None = None
    output_text: str | None = None
    token_input_total: int = 0
    token_output_total: int = 0
    cost_cents: int = 0
    search_count: int = 0
    error_code: str | None = None
    error_message: str | None = None
    request_id: str | None = None
    started_at: str | None = None
    created_at: str | None = None
    completed_at: str | None = None
    # W7 (工程师 B): structured output flag. True when the engine
    # produced a conclusion without any grounded source.
    is_inferred: bool = False


class CancelAiJobResponse(BaseModel):
    job_id: str
    was_queued: bool
    was_running: bool


class ListAiJobsItem(BaseModel):
    """One row in :class:`ListAiJobsResponse`.

    Mirrors the columns the BFF history page needs. ``published_research_id``
    is non-null iff ``status == "succeeded"`` AND the linked draft has been
    promoted to a published Research row (joined in the SQL).

    Note: ``status`` is typed as ``str`` (not ``AiJobStatus``) because
    Pydantic v2 cannot resolve ``Literal`` aliases that come from a sibling
    module — for v0 we keep the contract simple and validate at the BFF.
    """
    job_id: str
    topic: str
    status: str
    current_step: str | None = None
    report_type: str
    source_policy: str
    token_input_total: int = 0
    token_output_total: int = 0
    cost_cents: int = 0
    draft_research_id: str | None = None
    published_research_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    completed_at: str | None = None


class ListAiJobsResponse(BaseModel):
    items: list[ListAiJobsItem]
    total: int
    limit: int
    offset: int


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
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> dict[str, str]:
    return await _health_payload(request, store)


@app.get("/healthz")
async def healthz(
    request: Request,
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> dict[str, str]:
    return await _health_payload(request, store)


async def _health_payload(request: Request, store: JobStore) -> dict[str, str]:
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
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> SubmitAiJobResponse:
    if body.source_policy == "only_user_sources" and not body.source_refs:
        raise _http_error(
            "AI_INVALID_SOURCE_POLICY",
            "only_user_sources requires at least one source_ref",
        )

    resolved_source_refs: tuple[dict[str, str | bool], ...] = tuple(body.source_refs)
    from ai_engine.job_runner.db_store import DbJobStore
    if isinstance(store, DbJobStore):
        try:
            resolved_source_refs = await store.resolve_internal_source_refs(
                body.source_refs,
                requester_id=body.requester_id,
            )
        except AdapterError as exc:
            raise _http_error(exc.code, exc.message) from exc

    # W6: Idempotency replay — same (requester_id, idempotency_key) returns the
    # original job without enqueueing a new one. Status 200 instead of 202 so
    # clients can distinguish replay from fresh submit.
    if body.idempotency_key:
        existing = await store.find_by_idempotency_key(
            body.requester_id, body.idempotency_key
        )
        if existing is not None:
            snap = existing.snapshot
            return SubmitAiJobResponse(
                job_id=snap.job_id,
                status=snap.status,
                final_status=snap.status if snap.status in {"succeeded", "failed", "partial", "cancelled"} else None,
                current_step=snap.current_step,
                sources_count=len(snap.source_refs),
                token_input_total=0,
                token_output_total=0,
                cost_cents=0,
                search_count=0,
                error_code=None,
                error_message=None,
                request_id=getattr(request.state, "request_id", None),
            )

    # W6: Quota check — happens AFTER idempotency replay so replays don't
    # double-charge. Counts today's accepted submissions for the user and the
    # team (DB path sums across all users).
    user_used = await store.count_submissions_today(requester_id=body.requester_id)
    team_used = await store.count_submissions_today(team_scope=True)
    user_limit = int(os.environ.get("BUDGET_USER_DAILY", "5"))
    team_limit = int(os.environ.get("BUDGET_TEAM_DAILY", "20"))
    if user_used >= user_limit:
        raise _http_error_with_details(
            "AI_QUOTA_EXCEEDED",
            "个人今日 AI 调研配额已用完",
            {"scope": "user", "used": user_used, "limit": user_limit},
        )
    if team_used >= team_limit:
        raise _http_error_with_details(
            "AI_QUOTA_EXCEEDED",
            "团队今日 AI 调研配额已用完",
            {"scope": "team", "used": team_used, "limit": team_limit},
        )

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
        idempotency_key=body.idempotency_key,
        source_refs=resolved_source_refs,
    )
    await store.enqueue(snapshot)

    # 2. Fire-and-forget background runner. Week 1 review 修正：原版同步
    # await run_one_available_job 会阻塞 HTTP 连接 5 分钟。Week 2 起改
    # 后台 task，立即返回 202 + queued。BFF 后续 5s 轮询 GET 拿状态。
    #
    # 注意：必须显式把 request-scoped 的 store + adapter 捕获进 task —
    # 否则 request 结束后依赖被释放，且测试通过 app.dependency_overrides
    # 注入的 fake adapter / store 不会被后台 task 看到。
    adapter = _adapter_singleton()
    job_id = body.job_id
    request_id = getattr(request.state, "request_id", None)
    asyncio.create_task(
        _background_run(
            store=store,
            adapter=adapter,
            job_id=job_id,
            request_id=request_id,
        )
    )

    return SubmitAiJobResponse(
        job_id=job_id,
        status="queued",
        final_status=None,
        current_step=None,
        sources_count=0,
        token_input_total=0,
        token_output_total=0,
        cost_cents=0,
        search_count=0,
        error_code=None,
        error_message=None,
        request_id=request_id,
    )


async def _background_run(
    *,
    store: JobStore,
    adapter: ResearchEngineAdapter,
    job_id: str,
    request_id: str | None,
) -> None:
    """后台跑一个 job;出错仅记日志,不影响 HTTP 响应(已经返回)。

    store / adapter 从 endpoint 显式传 — 这样:
    1. 测试通过 app.dependency_overrides 注入的 fake adapter / InMemoryJobStore
       在后台 task 里仍可见(endpoint 已经 resolve 过);
    2. 生产 uvicorn 单进程场景下 request-scoped store 在 request 结束后会被释放,
       但 submit 自身是同步 path,store 在 task 创建时已经被引用,gather 期间
       不会释放。
    Week 2 引入 DB-backed store 后改成 process-global singleton,本签名不变。

    W2 review 修正:跑 succeeded 时 draft_factory 必须能 INSERT 一条 research 行
    返真 id。InMemoryJobStore 路径用线程级 _draft_for_test in-memory 模拟;
    DbJobStore 路径直连 Postgres 写 researches 表。
    """
    log = structlog.get_logger("ai_engine.runner")
    try:
        outcome = await run_one_available_job(
            store=store, adapter=adapter,
            draft_factory=_make_draft_factory(store),
        )
        if outcome is None:
            log.warning(
                "ai-engine.background.no_job",
                request_id=request_id,
                job_id=job_id,
            )
        else:
            log.info(
                "ai-engine.background.done",
                request_id=request_id,
                job_id=outcome.job_id,
                final_status=outcome.final_status,
                current_step=outcome.current_step,
                cost_cents=outcome.cost.cost_cents,
            )
    except Exception:
        log.exception(
            "ai-engine.background.unhandled",
            request_id=request_id,
            job_id=job_id,
        )
        # W2 review 修正:用 log.exception 已输出完整 traceback(JSON 渲染层
        # format_exc_info 链没装,但 stdlib logger 会写到 stderr 的 unhandled
        # 行附带 "Traceback (most recent call last): ...")。这里不再额外
        # print,避免把请求 body / env 变量刷到 stderr。


DraftFactory = Callable[[JobSnapshot, tuple[AdapterSource, ...], str], Awaitable[str | None]]


def _make_draft_factory(store: JobStore) -> DraftFactory:
    """根据 store 类型返回对应的 draft_factory (INSERT research row 返 id)。

    - DbJobStore: 复用 psycopg pool 直接 INSERT researches,返真 id;
    - InMemoryJobStore: 单元测试用,在 _drafts_for_tests dict 里写一份返 uuid。
    """
    from ai_engine.job_runner.db_store import DbJobStore as _Db

    if isinstance(store, _Db):

        async def _factory(
            snapshot: JobSnapshot, sources: tuple[AdapterSource, ...], output_text: str
        ) -> str | None:
            assert isinstance(store, _Db)
            # The runner may be retried after the draft INSERT committed but
            # before mark_terminal committed. Derive the draft id from the job
            # id so replaying the same job cannot create duplicate drafts.
            new_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"deep-research:ai-job:{snapshot.job_id}"))
            body = output_text.strip()
            origin_sha256 = hashlib.sha256(body.encode("utf-8")).hexdigest()
            sql = (
                'INSERT INTO "researches" '
                '("id", "type", "status", "title", "body", "authorId", "creationMethod", '
                ' "aiAssisted", "originContentSha256", "createdAt", "updatedAt") '
                "VALUES (%s, 'research', 'draft', %s, %s, %s, 'ai_research', true, %s, now(), now()) "
                'ON CONFLICT ("id") DO NOTHING'
            )
            async with store.pool.connection() as conn:
                async with conn.transaction():
                    await conn.execute(
                        sql,
                        (
                            new_id,
                            snapshot.topic[:300],
                            body,
                            snapshot.requester_id,
                            origin_sha256,
                        ),
                    )
            return new_id

        return _factory

    async def _in_memory_factory(
        snapshot: JobSnapshot, sources: tuple[AdapterSource, ...], output_text: str
    ) -> str | None:
        # InMemory 测试路径:用全局 dict 记录 fake draft id。
        # 让 _background_run 测试 / FakeAdapter 测试可走 succeeded。
        from ai_engine.job_runner.db_store import _drafts_for_tests
        new_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"deep-research:ai-job:{snapshot.job_id}"))
        _drafts_for_tests[new_id] = {
            "topic": snapshot.topic,
            "requester_id": snapshot.requester_id,
            "sources": len(sources),
            "body": output_text,
        }
        return new_id

    return _in_memory_factory


# ─── 列表（兼容 GET /api/ai/jobs） ───────────────────────────────────────────
#
# 历史表（v0）：列出某用户最近的 ai_research_jobs 行。
# 鉴权依赖 BFF：web 在调用本端前已 requireUser(query req.cookie) 并把 u.id
# 注入 querystring 的 requester_id。本端用 Pydantic `Query(min_length=36,
# max_length=36)` 强制 UUID —— 漏传/伪造直接 422，关闭 IDOR。
# "已发布" 判定在 SQL 层 LEFT JOIN researches WHERE status='published'，
# BFF 拿到 publishedResearchId 后挂"已发布" pill，无需前端跑 N+1。


# 只接受枚举里的合法值,空白/None 等同于"全部"
_VALID_LIST_STATUSES: tuple[AiJobStatus, ...] = (
    "queued", "running", "partial", "succeeded", "failed", "cancelled",
)


def _parse_status_filter(raw: str | None) -> tuple[AiJobStatus, ...] | None:
    """Comma-separated subset of AiJobStatus. None / "" → no filter.

    Raises HTTPException(422) on unknown values so the BFF surfaces the
    reason instead of getting an opaque empty list.
    """
    if not raw:
        return None
    out: list[AiJobStatus] = []
    for piece in (p.strip() for p in raw.split(",")):
        if not piece:
            continue
        if piece not in _VALID_LIST_STATUSES:
            # Keep it inside the catch-block so the BFF can translate.
            raise HTTPException(
                status_code=422,
                detail={"code": "VALIDATION_FAILED",
                        "message": f"unknown status {piece!r}"},
            )
        if piece not in out:
            out.append(piece)
    return tuple(out) if out else None


@app.get("/api/ai/jobs", response_model=ListAiJobsResponse)
async def list_ai_jobs(
    request: Request,
    store: Annotated[JobStore, Depends(_store_singleton)],
    requester_id: Annotated[str, Query(min_length=36, max_length=36)],
    status: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ListAiJobsResponse:
    rows = await store.list_jobs(
        requester_id=requester_id,
        status_filter=_parse_status_filter(status),
        limit=limit,
        offset=offset,
    )
    total = await store.count_jobs(
        requester_id=requester_id,
        status_filter=_parse_status_filter(status),
    )

    items: list[ListAiJobsItem] = []
    for view in rows:
        snap = view.snapshot
        items.append(
            ListAiJobsItem(
                job_id=snap.job_id,
                topic=snap.topic,
                status=snap.status,
                current_step=snap.current_step,
                report_type=snap.report_type,
                source_policy=snap.source_policy,
                token_input_total=getattr(view, "last_token_in", 0),
                token_output_total=getattr(view, "last_token_out", 0),
                cost_cents=getattr(view, "last_cost_cents", 0),
                draft_research_id=getattr(view, "draft_research_id", None),
                published_research_id=getattr(view, "published_research_id", None),
                error_code=getattr(view, "last_error_code", None),
                error_message=getattr(view, "last_error_message", None),
                created_at=_iso(getattr(view, "created_at", None)),
                updated_at=_iso(getattr(view, "updated_at", None)),
                completed_at=_iso(getattr(view, "completed_at", None)),
            )
        )
    return ListAiJobsResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
    )


def _iso(value: datetime | None) -> str | None:
    """ISO-8601 UTC string for the row timestamp; empty string → None."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


@app.get("/api/ai/jobs/{job_id}", response_model=SubmitAiJobResponse)
async def get_ai_job(
    job_id: Annotated[str, Path(min_length=1)],
    request: Request,
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> SubmitAiJobResponse:
    row: Any = await _store_get_row(store, job_id)
    if row is None:
        raise _http_error("AI_JOB_NOT_FOUND", f"job {job_id} not found")
    snap: JobSnapshot = row.snapshot
    last_sources = getattr(row, "last_sources", ())
    last_failed_sources = getattr(row, "last_failed_sources", ())
    # W7 (工程师 B): an inferred conclusion is one that succeeded with
    # zero grounded sources. We surface this on the response so the
    # BFF / UI can render it differently.
    is_inferred = snap.status == "succeeded" and len(last_sources) == 0
    error_stage = snap.current_step if snap.status in ("failed", "partial") else None
    return SubmitAiJobResponse(
        job_id=snap.job_id,
        status="stored",
        topic=snap.topic,
        final_status=snap.status,
        current_step=snap.current_step,
        sources_count=len(last_sources),
        partial_sources_count=len(last_sources),
        failed_sources_count=len(last_failed_sources),
        error_stage=error_stage,
        draft_research_id=getattr(row, "draft_research_id", None),
        report_type=snap.report_type,
        output_text=getattr(row, "output_text", None),
        token_input_total=getattr(row, "last_token_in", 0),
        token_output_total=getattr(row, "last_token_out", 0),
        cost_cents=getattr(row, "last_cost_cents", 0),
        search_count=len(last_sources),
        error_code=getattr(row, "last_error_code", None),
        error_message=getattr(row, "last_error_message", None),
        request_id=getattr(request.state, "request_id", None),
        started_at=_iso(getattr(row, "started_at", None)),
        created_at=_iso(getattr(row, "created_at", None)),
        completed_at=_iso(getattr(row, "completed_at", None)),
        is_inferred=is_inferred,
    )


async def _store_get_row(store: JobStore, job_id: str) -> Any | None:
    """Read a job row across sync (InMemory) and async (DB) stores."""
    maybe = store.get_row(job_id)
    if inspect.isawaitable(maybe):
        return await maybe
    return maybe


@app.post("/api/ai/jobs/{job_id}/cancel", response_model=CancelAiJobResponse)
async def cancel_ai_job(
    job_id: Annotated[str, Path(min_length=1)],
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> CancelAiJobResponse:
    row = await _store_get_row(store, job_id)
    if row is None:
        raise _http_error("AI_JOB_NOT_FOUND", f"job {job_id} not found")
    current_status = row.snapshot.status
    if current_status not in {"queued", "running"}:
        raise _http_error(
            "AI_JOB_NOT_CANCELLABLE",
            f"job {job_id} is already {current_status}",
        )

    previous_status = await store.cancel_job(job_id)
    if previous_status is None:
        raise _http_error(
            "AI_JOB_NOT_CANCELLABLE",
            f"job {job_id} changed state before cancellation",
        )

    # The DB queue is authoritative. Adapter cancellation is best-effort: a
    # process restart legitimately leaves no matching in-memory adapter job.
    adapter = _adapter_singleton()
    if previous_status == "running":
        try:
            await adapter.cancel(job_id)
        except AdapterError as exc:
            structlog.get_logger("ai_engine.cancel").warning(
                "ai-engine.cancel.adapter_missed",
                job_id=job_id,
                error_code=exc.code,
            )
    return CancelAiJobResponse(
        job_id=job_id,
        was_queued=previous_status == "queued",
        was_running=previous_status == "running",
    )


# ──────────────────────────────────────────────────────────────────────
# W4-2: POST /api/shares — user URL share → pending_review → admin approval
# ──────────────────────────────────────────────────────────────────────


class ShareUrlRequest(BaseModel):
    """Mirrors `packages/shared/src/schemas.ts ShareUrlInput`.

    Defence-in-depth validation in `validate_share_input` (server/share.py)
    runs after this Pydantic check.

    The BFF sends `userNote` (camelCase) per the shared Zod schema; we
    accept both `userNote` and `user_note` here. Same for `requesterId`.
    """

    url: str = Field(min_length=1, max_length=2048)
    user_note: str | None = Field(default=None, max_length=500, alias="userNote")
    requester_id: str = Field(
        default="00000000-0000-0000-0000-000000000001",
        alias="requesterId",
    )

    model_config = {"populate_by_name": True}


class ShareSubmitResponse(BaseModel):
    summary_id: str
    status: str
    canonical_url: str
    request_id: str | None = None


@app.post(
    "/api/shares",
    response_model=ShareSubmitResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_share(
    body: ShareUrlRequest,
    request: Request,
) -> ShareSubmitResponse:
    """Compatibility ingress that queues the frozen share_submissions model.

    The Web BFF normally inserts this row itself. If it forwards here instead,
    this endpoint follows the same queue and never invokes the retired
    ``server.share`` summary path.
    """
    from ai_engine.ingestion.pipeline import canonicalize_url
    from ai_engine.job_runner.db_store import DbJobStore as _Db

    parts = urlsplit(body.url)
    canonical = canonicalize_url(body.url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or not canonical:
        raise _http_error("VALIDATION_FAILED", "url must be an HTTP(S) URL")
    request_id = getattr(request.state, "request_id", None)
    store = _store_singleton()
    if not isinstance(store, _Db):
        return ShareSubmitResponse(
            summary_id="00000000-0000-0000-0000-000000000099",
            status="pending",
            canonical_url=canonical,
            request_id=request_id,
        )

    submission_id = str(uuid.uuid4())
    async with store.pool.connection() as conn:
        async with conn.transaction():
            existing = await (
                await conn.execute(
                    'SELECT "id", "status" FROM "share_submissions" '
                    'WHERE "submitterId" = %s AND "canonicalUrl" = %s '
                    "AND \"status\" = 'pending' LIMIT 1",
                    (body.requester_id, canonical),
                )
            ).fetchone()
            if existing is not None:
                existing_row = cast(dict[str, Any], existing)
                return ShareSubmitResponse(
                    summary_id=str(existing_row["id"]),
                    status=str(existing_row["status"]),
                    canonical_url=canonical,
                    request_id=request_id,
                )
            await conn.execute(
                'INSERT INTO "share_submissions" '
                '("id", "submitterId", "url", "canonicalUrl", "userNote", '
                '"status", "createdAt", "updatedAt") '
                "VALUES (%s, %s, %s, %s, %s, 'pending', now(), now())",
                (
                    submission_id,
                    body.requester_id,
                    body.url,
                    canonical,
                    body.user_note,
                ),
            )
    return ShareSubmitResponse(
        summary_id=submission_id,
        status="pending",
        canonical_url=canonical,
        request_id=request_id,
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


def _http_error_with_details(
    code: str, message: str, details: dict[str, object]
) -> HTTPException:
    """Like ``_http_error`` but attaches a `details` object for the BFF."""
    if code not in ERROR_CODES:
        code = "INTERNAL"
    http_status = HTTP_STATUS.get(code, 500)
    return HTTPException(
        status_code=http_status,
        detail={"code": code, "message": message, "details": details},
    )


__all__ = ["app", "build_adapter", "build_store", "FakeAdapter"]


# Quiet linter — referenced by future test files; avoid unused warning.
_ = (datetime, timezone, AI_JOB_STATUS, REPORT_TYPE, SOURCE_POLICY, CREATION_METHOD)
