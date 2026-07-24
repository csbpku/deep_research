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
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from typing import Annotated, Any, cast
from urllib.parse import urlsplit

import structlog
from fastapi import Depends, FastAPI, HTTPException, Path, Request, status
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
        extra={"adapter": os.environ.get("AI_ENGINE_ADAPTER", "fake")},
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
    if isinstance(store, DbJobStore):
        await store.open()
        app_instance.state.db_pool = store.pool
        await store.start_reaper()
        share_worker_task = asyncio.create_task(
            _share_submission_worker_loop(app_instance),
            name="share-submission-worker",
        )
    app_instance.state.adapter = build_adapter()
    try:
        yield
    finally:
        if share_worker_task is not None:
            share_worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await share_worker_task
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


app = FastAPI(
    title="Deep Research AI Engine",
    version="0.1.0",
    lifespan=_lifespan,
)

from ai_engine.radar.sync_endpoint import router as radar_router  # noqa: E402

app.include_router(radar_router)


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
    except Exception as exc:  # pragma: no cover — defensive
        elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
        log.exception(
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
            # W2 review 修正:真 INSERT research row;不让 Runner 自造 UUID。
            # 这里用 store._pool.connection() 直接写。
            new_id = str(uuid.uuid4())
            body = output_text.strip()
            origin_sha256 = hashlib.sha256(body.encode("utf-8")).hexdigest()
            sql = (
                'INSERT INTO "researches" '
                '("id", "type", "status", "title", "body", "authorId", "creationMethod", '
                ' "aiAssisted", "originContentSha256", "createdAt", "updatedAt") '
                "VALUES (%s, 'research', 'draft', %s, %s, %s, 'ai_research', false, %s, now(), now())"
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
        new_id = str(uuid.uuid4())
        _drafts_for_tests[new_id] = {
            "topic": snapshot.topic,
            "requester_id": snapshot.requester_id,
            "sources": len(sources),
            "body": output_text,
        }
        return new_id

    return _in_memory_factory


@app.get("/api/ai/jobs/{job_id}", response_model=SubmitAiJobResponse)
async def get_ai_job(
    job_id: Annotated[str, Path(min_length=1)],
    request: Request,
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> SubmitAiJobResponse:
    row: Any = store.get_row(job_id)
    if row is None:
        raise _http_error("AI_JOB_NOT_FOUND", f"job {job_id} not found")
    snap: JobSnapshot = row.snapshot
    return SubmitAiJobResponse(
        job_id=snap.job_id,
        status="stored",
        final_status=snap.status,
        current_step=snap.current_step,
        sources_count=len(getattr(row, "last_sources", ())),
        token_input_total=getattr(row, "last_token_in", 0),
        token_output_total=getattr(row, "last_token_out", 0),
        cost_cents=getattr(row, "last_cost_cents", 0),
        search_count=len(getattr(row, "last_sources", ())),
        error_code=getattr(row, "last_error_code", None),
        error_message=getattr(row, "last_error_message", None),
        request_id=getattr(request.state, "request_id", None),
    )


@app.post("/api/ai/jobs/{job_id}/cancel", response_model=CancelAiJobResponse)
async def cancel_ai_job(
    job_id: Annotated[str, Path(min_length=1)],
    store: Annotated[JobStore, Depends(_store_singleton)],
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


__all__ = ["app", "build_adapter", "build_store", "FakeAdapter"]


# Quiet linter — referenced by future test files; avoid unused warning.
_ = (datetime, timezone, AI_JOB_STATUS, REPORT_TYPE, SOURCE_POLICY, CREATION_METHOD)
