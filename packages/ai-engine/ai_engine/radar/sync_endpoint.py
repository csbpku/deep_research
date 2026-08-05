"""FastAPI routes for radar synchronization and run history."""

from __future__ import annotations

import asyncio
from datetime import date, datetime
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Request, status
from pydantic import BaseModel, Field

from ai_engine.adapters.base import ResearchEngineAdapter
from ai_engine.radar.daily_digest import generate_daily_digest
from ai_engine.radar.enrichment_worker import (
    _generate_web_highlights as _gen_highlights,
)
from ai_engine.radar.sync_runner import (
    _is_low_quality_content as _is_lq_highlight,
)
from ai_engine.radar.sync_runner import retry_radar_run, run_radar_pipeline
from ai_engine.radar.distilled_scorer import ScoringMonitor, score_with_llm

router = APIRouter(prefix="/api/radar", tags=["radar"])




class RadarSyncBody(BaseModel):
    triggered_by: Literal["cron", "admin"] = Field(default="admin", alias="triggeredBy")

    model_config = {"populate_by_name": True}


class RadarSyncAccepted(BaseModel):
    runId: str
    status: str = "queued"
    requestId: str


class RadarDigestRegenerateBody(BaseModel):
    target_date: date | None = Field(default=None, alias="targetDate")

    model_config = {"populate_by_name": True}


class RadarRunView(BaseModel):
    id: str
    sourceId: str
    sourceName: str
    sourceType: str
    triggeredBy: str
    status: str
    totalFetched: int
    totalNew: int
    totalSkipped: int
    totalFailed: int
    tokenInputTotal: int
    tokenOutputTotal: int
    costUsd: float
    elapsedMs: int | None
    errorCode: str | None
    createdAt: str
    completedAt: str | None


def _pool(request: Request) -> Any:
    pool = getattr(request.app.state, "db_pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail={"code": "AI_ENGINE_UNAVAILABLE"})
    return pool


def _adapter(request: Request) -> ResearchEngineAdapter:
    adapter = getattr(request.app.state, "adapter", None)
    if adapter is None:
        from ai_engine.adapters.base import build_adapter

        adapter = build_adapter()
    return adapter


def _require_internal_token(request: Request) -> None:
    """Reject calls without the shared INTERNAL_SERVICE_TOKEN (P1-A2).

    The token is configured identically in apps/web and ai-engine. Calls
    lacking the header (or with a wrong value) get 403 — preventing anonymous
    operators on the internal Docker network from triggering sync / digest /
    runs read endpoints.

    ``RADAR_DISABLE_INTERNAL_TOKEN=1`` is honored for local dev only; tests
    that need to bypass must inject the dependency via FastAPI overrides.
    """
    import os

    if os.environ.get("RADAR_DISABLE_INTERNAL_TOKEN") == "1":
        return
    expected = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail={"code": "INTERNAL_TOKEN_NOT_CONFIGURED"},
        )
    provided = request.headers.get("x-internal-token", "")
    if not provided or provided != expected:
        raise HTTPException(
            status_code=403,
            detail={"code": "INTERNAL_TOKEN_MISMATCH"},
        )


async def _has_active_run(pool: Any) -> bool:
    """Return True if any radar_sync_runs row is currently ``running``.

    Used by POST /sync and POST /digest/regenerate to refuse double-triggering
    while a previous batch is still in flight (P1-A2 防重复). ``running`` rows
    with a stale lease are not cleaned here — that's the reaper's job; the
    Admin console surfaces their age separately.
    """
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT 1 FROM "radar_sync_runs" '
                "WHERE \"status\" = 'running' LIMIT 1"
            )
        ).fetchone()
    return row is not None


@router.post("/enrich/highlights", status_code=status.HTTP_202_ACCEPTED)
async def enqueue_highlights(
    pool: Any = Depends(_pool),
    _token: None = Depends(_require_internal_token),
) -> dict[str, Any]:
    """Batch re-generate highlights for web/rss candidates."""
    import json as _json
    import structlog

    async def _run() -> None:
        async with pool.connection() as conn:
            rows = await (await conn.execute(
                "SELECT \"id\", \"title\", \"originalMarkdown\" FROM \"summaries\" "
                "WHERE \"originalMarkdown\" IS NOT NULL "
                "AND \"originalMarkdown\" <> \'\' "
                "AND \"originalKind\" IN (\'rss\', \'web_share\') "
                "AND (\"highlights\" IS NULL OR \"highlights\" = \'{}\'::jsonb) "
                "ORDER BY \"createdAt\" DESC LIMIT 50"
            )).fetchall()
        if not rows:
            return
        succeeded = 0
        for r in rows:
            sid = str(r["id"])
            title = str(r["title"] or "")
            md = str(r["originalMarkdown"] or "")
            if not md or _is_lq_highlight(md):
                continue
            hl = await _gen_highlights(md, title)
            if hl:
                async with pool.connection() as conn2:
                    await conn2.execute(
                        "UPDATE \"summaries\" SET \"highlights\" = %s::jsonb, \"updatedAt\" = now() WHERE \"id\" = %s",
                        (_json.dumps(hl, ensure_ascii=False), sid),
                    )
                succeeded += 1
        structlog.get_logger("ai_engine.radar").info(
            "ai-engine.radar.highlights_done", enriched=succeeded,
        )

    import asyncio as _asyncio
    _asyncio.create_task(_run())
    return {"status": "queued"}


async def _run_background(
    *,
    pool: Any,
    adapter: ResearchEngineAdapter,
    triggered_by: str,
    request_id: str,
    lock: asyncio.Lock | None = None,
) -> None:
    log = structlog.get_logger("ai_engine.radar")
    try:
        async def _run() -> tuple[Any, ScoringMonitor]:
            monitor = ScoringMonitor()
            result = await run_radar_pipeline(
                pool,
                triggered_by=triggered_by,
                adapter=adapter,
                distilled_scorer=score_with_llm,
                monitor=monitor,
            )
            return result, monitor

        if lock is None:
            pipeline_result, monitor = await _run()
        else:
            async with lock:
                pipeline_result, monitor = await _run()
        result = pipeline_result.sync
        alerts = monitor.evaluate()
        log.info(
            "ai-engine.radar.sync_done",
            request_id=request_id,
            batch_id=result.batch_id,
            source_runs=len(result.runs),
            distilled_scored=monitor.total_count - monitor.default_count,
            distilled_default=monitor.default_count,
            must_read=monitor.must_read_count,
            alerts=alerts,
        )
        log.info(
            "ai-engine.radar.tracked_repo_done",
            request_id=request_id,
            **pipeline_result.tracked_repo_result,
        )
        log.info(
            "ai-engine.radar.enrich_done",
            request_id=request_id,
            enriched_count=pipeline_result.enriched_count,
            enrichment_elapsed_ms=pipeline_result.enrichment_elapsed_ms,
            enrichment_error=pipeline_result.enrichment_error,
        )
        log.info(
            "ai-engine.radar.digest_done",
            request_id=request_id,
            summary_id=pipeline_result.digest_summary_id,
            candidate_count=pipeline_result.digest_candidate_count,
            narrative_degraded=pipeline_result.digest_narrative_degraded,
            elapsed_ms=pipeline_result.digest_elapsed_ms,
            error=pipeline_result.digest_error,
        )
    except Exception as exc:
        log.error(
            "ai-engine.radar.sync_unhandled",
            request_id=request_id,
            error_type=type(exc).__name__,
        )


@router.post("/sync", response_model=RadarSyncAccepted, status_code=status.HTTP_202_ACCEPTED)
async def sync_radar(
    body: RadarSyncBody,
    request: Request,
    background_tasks: BackgroundTasks,
    pool: Annotated[Any, Depends(_pool)],
    adapter: Annotated[ResearchEngineAdapter, Depends(_adapter)],
    _token: Annotated[None, Depends(_require_internal_token)] = None,
) -> RadarSyncAccepted:
    request_id = str(getattr(request.state, "request_id", ""))
    # P1-A2 防重复:active run 已存在时拒绝再次触发；让 Admin UI 给出明确反馈。
    if await _has_active_run(pool):
        raise HTTPException(
            status_code=409,
            detail={"code": "RADAR_SYNC_ALREADY_RUNNING"},
        )
    accepted_id = request_id
    background_tasks.add_task(
        _run_background,
        pool=pool,
        adapter=adapter,
        triggered_by=body.triggered_by,
        request_id=request_id,
        lock=getattr(request.app.state, "radar_sync_lock", None),
    )
    return RadarSyncAccepted(runId=accepted_id, requestId=request_id)


@router.post(
    "/digest/regenerate",
    response_model=RadarSyncAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def regenerate_digest(
    body: RadarDigestRegenerateBody,
    request: Request,
    background_tasks: BackgroundTasks,
    pool: Annotated[Any, Depends(_pool)],
    _token: Annotated[None, Depends(_require_internal_token)] = None,
) -> RadarSyncAccepted:
    """Regenerate one digest without re-running source synchronization."""
    request_id = str(getattr(request.state, "request_id", ""))
    if await _has_active_run(pool):
        raise HTTPException(
            status_code=409,
            detail={"code": "RADAR_SYNC_ALREADY_RUNNING"},
        )
    lock = getattr(request.app.state, "radar_sync_lock", None)

    async def _regenerate() -> None:
        async def _run() -> None:
            digest_date = body.target_date or datetime.now(
                ZoneInfo("Asia/Shanghai")
            ).date()
            await generate_daily_digest(pool, target_date=digest_date)

        try:
            if lock is None:
                await _run()
            else:
                async with lock:
                    await _run()
        except Exception as exc:
            structlog.get_logger("ai_engine.radar").error(
                "ai-engine.radar.digest_regenerate_failed",
                request_id=request_id,
                error_type=type(exc).__name__,
            )

    background_tasks.add_task(_regenerate)
    return RadarSyncAccepted(runId=request_id, requestId=request_id)


async def run_radar_daily_job(
    *,
    pool: Any,
    adapter: ResearchEngineAdapter,
    triggered_by: Literal["cron", "admin"],
    request_id: str,
    lock: asyncio.Lock | None = None,
) -> None:
    """Shared complete radar task used by cron and the host-level script."""
    await _run_background(
        pool=pool,
        adapter=adapter,
        triggered_by=triggered_by,
        request_id=request_id,
        lock=lock,
    )


@router.get("/runs", response_model=list[RadarRunView])
async def list_radar_runs(
    request: Request,
    pool: Annotated[Any, Depends(_pool)],
    _token: Annotated[None, Depends(_require_internal_token)] = None,
    limit: int = 50,
) -> list[RadarRunView]:
    bounded_limit = min(max(limit, 1), 200)
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT r."id", r."sourceId", s."name" AS "sourceName", '
                's."sourceType", r."triggeredBy", r."status", r."totalFetched", '
                'r."totalNew", r."totalSkipped", r."totalFailed", r."tokenInputTotal", '
                'r."tokenOutputTotal", r."costUsd", r."elapsedMs", r."errorCode", '
                'r."createdAt", r."completedAt" FROM "radar_sync_runs" r '
                'JOIN "radar_sources" s ON s."id" = r."sourceId" '
                'ORDER BY r."createdAt" DESC LIMIT %s',
                (bounded_limit,),
            )
        ).fetchall()
    result: list[RadarRunView] = []
    for raw in rows:
        row = dict(raw)
        result.append(
            RadarRunView(
                **{
                    **row,
                    "id": str(row["id"]),
                    "sourceId": str(row["sourceId"]),
                    "status": str(row["status"]),
                    "createdAt": row["createdAt"].isoformat(),
                    "completedAt": (
                        row["completedAt"].isoformat() if row.get("completedAt") else None
                    ),
                }
            )
        )
    return result


@router.post(
    "/sync/{run_id}/retry",
    response_model=RadarSyncAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_sync(
    request: Request,
    run_id: Annotated[str, Path(min_length=1)],
    pool: Annotated[Any, Depends(_pool)],
    adapter: Annotated[ResearchEngineAdapter, Depends(_adapter)],
    _token: Annotated[None, Depends(_require_internal_token)] = None,
) -> RadarSyncAccepted:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id" FROM "radar_sync_runs" WHERE "id" = %s '
                "AND \"status\" IN ('partial', 'failed')",
                (run_id,),
            )
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "AI_JOB_NOT_FOUND"})
    request_id = str(getattr(request.state, "request_id", ""))

    async def _retry() -> None:
        try:
            monitor = ScoringMonitor()
            await retry_radar_run(
                pool,
                run_id,
                adapter=adapter,
                distilled_scorer=score_with_llm,
                monitor=monitor,
            )
        except Exception as exc:
            structlog.get_logger("ai_engine.radar").error(
                "ai-engine.radar.retry_unhandled",
                request_id=request_id,
                run_id=run_id,
                error_type=type(exc).__name__,
            )

    asyncio.create_task(_retry())
    return RadarSyncAccepted(runId=run_id, requestId=request_id)


__all__ = ["router", "run_radar_daily_job"]
