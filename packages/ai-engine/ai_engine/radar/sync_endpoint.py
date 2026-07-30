"""FastAPI routes for radar synchronization and run history."""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Request, status
from pydantic import BaseModel, Field

from ai_engine.adapters.base import ResearchEngineAdapter
from ai_engine.radar.sync_runner import retry_radar_run, run_radar_sync
from ai_engine.radar.distilled_scorer import ScoringMonitor, score_with_llm

router = APIRouter(prefix="/api/radar", tags=["radar"])


class RadarSyncBody(BaseModel):
    triggered_by: Literal["cron", "admin"] = Field(default="admin", alias="triggeredBy")

    model_config = {"populate_by_name": True}


class RadarSyncAccepted(BaseModel):
    runId: str
    status: str = "queued"
    requestId: str


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


async def _run_background(
    *,
    pool: Any,
    adapter: ResearchEngineAdapter,
    triggered_by: str,
    request_id: str,
) -> None:
    log = structlog.get_logger("ai_engine.radar")
    try:
        monitor = ScoringMonitor()
        result = await run_radar_sync(
            pool,
            triggered_by=triggered_by,
            adapter=adapter,
            distilled_scorer=score_with_llm,
            monitor=monitor,
        )
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
) -> RadarSyncAccepted:
    request_id = str(getattr(request.state, "request_id", ""))
    accepted_id = request_id
    background_tasks.add_task(
        _run_background,
        pool=pool,
        adapter=adapter,
        triggered_by=body.triggered_by,
        request_id=request_id,
    )
    return RadarSyncAccepted(runId=accepted_id, requestId=request_id)


@router.get("/runs", response_model=list[RadarRunView])
async def list_radar_runs(
    request: Request,
    pool: Annotated[Any, Depends(_pool)],
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


__all__ = ["router"]
