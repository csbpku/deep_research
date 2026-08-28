"""FastAPI routes for radar synchronization and run history."""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

import structlog
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Path,
    Query,
    Request,
    status,
)
from pydantic import BaseModel, Field

from ai_engine.adapters.base import ResearchEngineAdapter
from ai_engine.radar.enrichment_worker import (
    _generate_web_highlights as _gen_highlights,
    run_enrichment_for_pending,
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


class RadarEnrichmentBody(BaseModel):
    summary_ids: list[str] = Field(
        min_length=1,
        max_length=50,
        alias="summaryIds",
    )
    force: bool = True

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
    errorMessage: str | None
    createdAt: str
    completedAt: str | None
    candidateCount: int
    scoredCount: int
    pendingScoreCount: int
    enrichedCount: int
    pendingEnrichmentCount: int
    skippedExisting: int
    skippedRuleNoise: int
    skippedDistilledNoise: int
    skippedConflict: int


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
    operators on the internal Docker network from triggering sync or runs
    read endpoints.

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


async def reap_stale_radar_runs(pool: Any) -> int:
    """Fail radar runs whose lease expired or predates lease support."""
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
            'UPDATE "radar_sync_runs" SET "status" = \'failed\', '
            '"errorCode" = \'STALE_RUN_REAPED\', '
            '"errorMessage" = \'reaped stale running radar run\', '
            '"completedAt" = now(), "elapsedMs" = '
            '(EXTRACT(EPOCH FROM (now() - "createdAt")) * 1000)::int, '
            '"lockedBy" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL '
            'WHERE "status" = \'running\' '
            'AND ('
            '  "leaseExpiresAt" < now() '
            '  OR ("leaseExpiresAt" IS NULL '
            '      AND "createdAt" < now() - interval \'15 minutes\')'
            ') RETURNING "id"'
            )
        ).fetchall()
        await conn.commit()
    return len(rows)


async def _has_active_run(pool: Any) -> bool:
    """Return True after reaping expired or legacy running rows."""
    await reap_stale_radar_runs(pool)
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


@router.post("/enrich", status_code=status.HTTP_202_ACCEPTED)
async def enqueue_radar_enrichment(
    body: RadarEnrichmentBody,
    pool: Any = Depends(_pool),
    _token: None = Depends(_require_internal_token),
) -> dict[str, Any]:
    """Queue explicit deep-dive enrichment for selected radar candidates."""
    summary_ids = tuple(dict.fromkeys(body.summary_ids))

    async def _run_body() -> None:
        enriched = await run_enrichment_for_pending(
            pool,
            limit=len(summary_ids),
            summary_ids=summary_ids,
            force=body.force,
        )
        rescored = 0
        if body.force and enriched > 0:
            from ai_engine.radar.candidate_postprocessor import score_missing_candidates

            rescored = await score_missing_candidates(
                pool,
                limit=len(summary_ids),
                summary_ids=summary_ids,
                rescore=True,
            )
        structlog.get_logger("ai_engine.radar").info(
            "ai-engine.radar.manual_enrichment_done",
            requested=len(summary_ids),
            enriched=enriched,
            rescored=rescored,
        )
    async def _run() -> None:
        try:
            await _run_body()
        except Exception as exc:
            structlog.get_logger("ai_engine.radar").warning(
                "ai-engine.radar.enrichment_task_failed",
                error_type=type(exc).__name__,
            )
        finally:
            async with pool.connection() as conn:
                placeholders = ",".join(["%s"] * len(summary_ids))
                await conn.execute(
                    'UPDATE "summaries" SET "tags" = array_remove("tags", \'migration_queued_v2\'), '
                    '"updatedAt" = now() WHERE "id" IN (' + placeholders + ')',
                    summary_ids,
                )
                await conn.commit()

    asyncio.create_task(_run())
    return {"status": "queued", "summaryIds": list(summary_ids)}


async def _run_background(
    *,
    pool: Any,
    adapter: ResearchEngineAdapter,
    triggered_by: str,
    request_id: str,
    lock: asyncio.Lock | None = None,
    source_ids: set[str] | None = None,
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
                source_ids=source_ids,
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
            "ai-engine.radar.enrich_done",
            request_id=request_id,
            enriched_count=pipeline_result.enriched_count,
            enrichment_elapsed_ms=pipeline_result.enrichment_elapsed_ms,
            enrichment_error=pipeline_result.enrichment_error,
        )
        # Refresh only topics that already exist. New-topic proposal generation
        # is intentionally a separate Admin-triggered chain.
        try:
            from ai_engine.radar.topic_aggregation_worker import run_topic_aggregation

            topic_result = await run_topic_aggregation(pool)
            log.info(
                "ai-engine.radar.topic_refresh_done",
                request_id=request_id,
                **topic_result,
            )
        except Exception as exc:
            # Topic refresh must not turn a successful radar sync into a failed
            # run; the next radar run or manual refresh can retry it.
            log.warning(
                "ai-engine.radar.topic_refresh_failed",
                request_id=request_id,
                error_type=type(exc).__name__,
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


async def run_radar_sync_job(
    *,
    pool: Any,
    adapter: ResearchEngineAdapter,
    triggered_by: Literal["cron", "admin"],
    request_id: str,
    lock: asyncio.Lock | None = None,
    source_ids: set[str] | None = None,
) -> None:
    """Shared radar task used by the cron loop and host-level script."""
    if await _has_active_run(pool):
        structlog.get_logger("ai_engine.radar").info(
            "ai-engine.radar.sync_skipped_active_run",
            request_id=request_id,
        )
        return
    await _run_background(
        pool=pool,
        adapter=adapter,
        triggered_by=triggered_by,
        request_id=request_id,
        lock=lock,
        source_ids=source_ids,
    )


@router.get("/runs", response_model=list[RadarRunView])
async def list_radar_runs(
    request: Request,
    pool: Annotated[Any, Depends(_pool)],
    _token: Annotated[None, Depends(_require_internal_token)] = None,
    limit: int = 50,
    run_date: date | None = Query(default=None, alias="date"),
) -> list[RadarRunView]:
    bounded_limit = min(max(limit, 1), 200)
    params: list[Any] = []
    where_clause = ""
    if run_date is not None:
        start_at = datetime.combine(
            run_date,
            datetime.min.time(),
            tzinfo=ZoneInfo("Asia/Shanghai"),
        )
        where_clause = 'WHERE r."createdAt" >= %s AND r."createdAt" < %s '
        params.extend((start_at, start_at + timedelta(days=1)))
    params.append(bounded_limit)
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT r."id", r."sourceId", s."name" AS "sourceName", '
                's."sourceType", r."triggeredBy", r."status", r."totalFetched", '
                'r."totalNew", r."totalSkipped", r."totalFailed", r."tokenInputTotal", '
                'r."tokenOutputTotal", r."costUsd", r."elapsedMs", r."errorCode", r."errorMessage", '
                'r."skippedExisting", r."skippedRuleNoise", r."skippedDistilledNoise", r."skippedConflict", '
                'r."createdAt", r."completedAt", '
                'COUNT(c."id")::int AS "candidateCount", '
                'COUNT(c."id") FILTER (WHERE c."distilledScore" IS NOT NULL)::int AS "scoredCount", '
                'COUNT(c."id") FILTER (WHERE c."distilledScore" IS NULL)::int AS "pendingScoreCount", '
                'COUNT(c."id") FILTER (WHERE c."originalMeta" IS NOT NULL)::int AS "enrichedCount", '
                'COUNT(c."id") FILTER (WHERE c."originalMeta" IS NULL)::int AS "pendingEnrichmentCount" '
                'FROM "radar_sync_runs" r '
                'JOIN "radar_sources" s ON s."id" = r."sourceId" '
                'LEFT JOIN "summaries" c ON c."syncRunId" = r."id" '
                f"{where_clause}"
                'GROUP BY r."id", s."name", s."sourceType" '
                'ORDER BY r."createdAt" DESC LIMIT %s',
                tuple(params),
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
    if await _has_active_run(pool):
        raise HTTPException(
            status_code=409,
            detail={"code": "RADAR_SYNC_ALREADY_RUNNING"},
        )
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id" FROM "radar_sync_runs" WHERE "id" = %s ',
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


__all__ = ["router", "reap_stale_radar_runs", "run_radar_sync_job"]
