"""FastAPI routes for topic aggregation + synthesis (P1-D admin/manual triggers).

These endpoints are protected by the shared INTERNAL_SERVICE_TOKEN (same as
``/api/radar/*``). The BFF (apps/web) calls them when an admin clicks
"立即聚合" on /topics or "重试综述" on /topics/[slug].
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from ai_engine.radar.topic_aggregation_worker import run_topic_aggregation
from ai_engine.radar.topic_synthesis_worker import run_topic_synthesis

router = APIRouter(prefix="/api/topics", tags=["topics"])


def _pool(request: Request) -> Any:
    pool = getattr(request.app.state, "db_pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail={"code": "AI_ENGINE_UNAVAILABLE"})
    return pool


# Reuse the same internal token check as radar routes by importing it.
def _require_internal_token(request: Request) -> None:
    from ai_engine.radar.sync_endpoint import _require_internal_token  # noqa: WPS433

    _require_internal_token(request)


class TopicAggregateResponse(BaseModel):
    topicsCreated: int
    candidatesLinked: int
    staleRemoved: int


class TopicSynthesizeResponse(BaseModel):
    processed: int
    succeeded: int
    failed: int


@router.post(
    "/aggregate",
    response_model=TopicAggregateResponse,
    status_code=status.HTTP_200_OK,
)
async def aggregate_topics(
    request: Request,
    pool: Any = Depends(_pool),
    _token: None = Depends(_require_internal_token),
) -> TopicAggregateResponse:
    """Manually trigger one topic aggregation pass.

    Returns the same stats the worker's structured log emits. Safe to call
    repeatedly (idempotent upserts).
    """
    log = structlog.get_logger("ai_engine.radar.topic_agg")
    try:
        result = await run_topic_aggregation(pool)
    except Exception as exc:
        log.error(
            "ai-engine.radar.topic_agg.manual_failed",
            error_type=type(exc).__name__,
            exc_message=str(exc)[:200],
        )
        raise HTTPException(
            status_code=500,
            detail={
                "code": "TOPIC_AGGREGATION_FAILED",
                "message": str(exc)[:500],
                "errorType": type(exc).__name__,
            },
        ) from exc
    return TopicAggregateResponse(
        topicsCreated=result["topics_created"],
        candidatesLinked=result["candidates_linked"],
        staleRemoved=result["stale_removed"],
    )


@router.post(
    "/synthesize",
    response_model=TopicSynthesizeResponse,
    status_code=status.HTTP_200_OK,
)
async def synthesize_topics(
    request: Request,
    pool: Any = Depends(_pool),
    _token: None = Depends(_require_internal_token),
) -> TopicSynthesizeResponse:
    """Manually trigger one topic synthesis pass (LLM)."""
    try:
        result = await run_topic_synthesis(pool)
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail={"code": "TOPIC_SYNTHESIS_FAILED"}
        ) from exc
    return TopicSynthesizeResponse(
        processed=result["processed"],
        succeeded=result["succeeded"],
        failed=result["failed"],
    )


__all__ = ["router"]
