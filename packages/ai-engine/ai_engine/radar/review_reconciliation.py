"""Converge radar enrichment, content review, and browser review state.

The enrichment event is only one way a row can become eligible for review.
This worker deliberately scans persisted state as well, so old rows, process
restarts, provider outages, and partially completed enrichments eventually
reach an explicit terminal state.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any

from ai_engine.radar.content_reviewer import (
    claim_content_review,
    persist_quality_manual_review,
    run_content_review_cycle,
)
from ai_engine.radar.reader_quality import load_and_persist_reader_quality
from ai_engine.radar.reader_quality import READER_QUALITY_VERSION
from ai_engine.radar.render_review_worker import (
    RENDER_REVIEW_TRANSIENT_MAX_ROUNDS,
    queue_render_review,
)

logger = logging.getLogger("ai_engine.radar.review_reconciliation")


@dataclass(frozen=True, slots=True)
class ReviewReconciliationResult:
    candidates: int = 0
    content_claimed: int = 0
    content_terminal: int = 0
    quality_manual: int = 0
    render_queued: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "candidates": self.candidates,
            "content_claimed": self.content_claimed,
            "content_terminal": self.content_terminal,
            "quality_manual": self.quality_manual,
            "render_queued": self.render_queued,
        }


def _limit() -> int:
    return max(1, int(os.environ.get("RADAR_REVIEW_RECONCILIATION_BATCH_SIZE", "2")))


async def review_enriched_summary(
    pool: Any,
    *,
    summary_id: str,
    force: bool = False,
) -> dict[str, Any] | None:
    """Run the quality/content/browser handoff for one summary.

    The claim happens before any LLM call.  A stale ``reviewing`` lease can be
    reclaimed, while a healthy active claim is left untouched.
    """
    claimed = await claim_content_review(
        pool,
        summary_id=summary_id,
        force=force,
    )
    if not claimed:
        return None
    # Production claims are UUID strings. Tests and older embedders may still
    # return a truthy boolean; keeping that compatibility simply omits the
    # optional token guard for those callers.
    claim_id = claimed if isinstance(claimed, str) else None

    quality = await load_and_persist_reader_quality(
        pool,
        summary_id=summary_id,
        claim_id=claim_id,
    )
    if not quality.ready:
        await persist_quality_manual_review(
            pool,
            summary_id=summary_id,
            quality=quality.to_dict(),
            claim_id=claim_id,
        )
        review_status = "needs_manual_review"
        quality_manual = True
    else:
        review = await run_content_review_cycle(
            pool,
            summary_id=summary_id,
            claim_id=claim_id,
        )
        review_status = review.status
        quality_manual = False

    queued = False
    if review_status in {"approved", "needs_manual_review"}:
        queued = await queue_render_review(
            pool,
            summary_id=summary_id,
        )
    return {
        "summary_id": summary_id,
        "quality_status": quality.status,
        "content_status": review_status,
        "quality_manual": quality_manual,
        "render_queued": queued,
    }


async def finalize_enrichment(
    pool: Any,
    *,
    summary_id: str,
    force_review: bool = False,
) -> dict[str, Any]:
    """Close the enrichment state machine for one persisted snapshot.

    Every enrichment entry point calls this after its source-specific write.
    Low-tier rows still receive a deterministic quality result; high-value
    rows additionally enter the recoverable content/browser review pipeline.
    ``force_review`` is reserved for an explicit fresh snapshot and never
    means "approve".
    """
    quality = await load_and_persist_reader_quality(
        pool,
        summary_id=summary_id,
    )
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "distilledTier" FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
    tier = str(row.get("distilledTier") or "") if row else ""
    review = None
    if tier in {"collection", "deep_read"}:
        review = await review_enriched_summary(
            pool,
            summary_id=summary_id,
            force=force_review,
        )
    return {
        "summary_id": summary_id,
        "quality_status": quality.status,
        "content_status": review["content_status"] if review else None,
        "render_queued": bool(review and review["render_queued"]),
        "review": review,
    }


async def _review_candidates(pool: Any, *, limit: int) -> list[str]:
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id" FROM "summaries" '
                'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') = \'2.0\' '
                'AND ('
                '"contentReviewStatus" IS NULL '
                'OR ("contentReviewStatus" = \'reviewing\' AND '
                '"contentReviewStartedAt" < now() - make_interval(secs => %s)) '
                'OR ("contentReviewStatus" = \'needs_manual_review\' AND '
                '"contentReviewDetails"->>\'reason\' = \'reader_quality_gate\' '
                'AND "readerQualityStatus" = \'ready\') '
                'OR ("contentReviewStatus" IN (\'approved\', \'needs_manual_review\') '
                'AND "originalSha256" IS NOT NULL '
                'AND "contentReviewSummary"->>\'contentSha256\' IS DISTINCT FROM '
                '"originalSha256")'
                ') '
                'ORDER BY "createdAt" ASC LIMIT %s',
                (max(300, int(os.environ.get(
                    "RADAR_CONTENT_REVIEW_STALE_MINUTES", "30",
                )) * 60), limit),
            )
        ).fetchall()
    return [str(row["id"]) for row in rows]


async def _refresh_stale_reader_quality(pool: Any, *, limit: int) -> int:
    """Recompute deterministic quality when the contract version changes."""
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id" FROM "summaries" '
                'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND ('
                'COALESCE("readerQualityDetails"->>\'version\', \'\') '
                'IS DISTINCT FROM %s '
                'OR ('
                '"originalSha256" IS NOT NULL '
                'AND "readerQualityDetails"->>\'contentSha256\' '
                'IS DISTINCT FROM "originalSha256"'
                ') '
                'OR ('
                '"originalSha256" IS NULL '
                'AND "readerQualityDetails"->>\'contentSha256\' IS NULL'
                ')'
                ') '
                'ORDER BY "createdAt" ASC LIMIT %s',
                (READER_QUALITY_VERSION, limit),
            )
        ).fetchall()
    refreshed = 0
    for row in rows:
        await load_and_persist_reader_quality(
            pool,
            summary_id=str(row["id"]),
        )
        refreshed += 1
    return refreshed


async def _queue_missing_render_reviews(pool: Any, *, limit: int) -> int:
    """Queue rows whose content review is terminal but browser review is absent."""
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id" FROM "summaries" '
                'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND "contentReviewStatus" IN (\'approved\', \'needs_manual_review\') '
                'AND "renderReviewStatus" IS NULL '
                'AND COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') = \'2.0\' '
                'AND COALESCE("originalMarkdown", \'\') <> \'\' '
                'ORDER BY "createdAt" ASC LIMIT %s',
                (limit,),
            )
        ).fetchall()
    queued = 0
    for row in rows:
        if await queue_render_review(pool, summary_id=str(row["id"])):
            queued += 1
    return queued


async def _queue_stale_render_reviews(pool: Any, *, limit: int) -> int:
    """Requeue terminal browser audits that are not bound to this snapshot."""
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id" FROM "summaries" '
                'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND "contentReviewStatus" IN (\'approved\', \'needs_manual_review\') '
                'AND "renderReviewStatus" IN '
                '(\'approved\', \'needs_manual_review\', \'unavailable\') '
                'AND "renderReviewDetails"->>\'contentSha256\' IS DISTINCT FROM '
                '"originalSha256" '
                'AND COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') = \'2.0\' '
                'AND COALESCE("originalMarkdown", \'\') <> \'\' '
                'ORDER BY "createdAt" ASC LIMIT %s',
                (limit,),
            )
        ).fetchall()
    queued = 0
    for row in rows:
        if await queue_render_review(pool, summary_id=str(row["id"])):
            queued += 1
    return queued


async def _queue_transient_unavailable_render_reviews(
    pool: Any,
    *,
    limit: int,
) -> int:
    """Retry sidecar/infrastructure failures without retrying page findings.

    ``unavailable`` is terminal for a review attempt, but a temporary sidecar
    outage should not permanently hide a healthy page. Preserve the current
    round so the normal two-round cap still applies; page-level failures do
    not match this allow-list and remain manual.
    """
    transient_error = (
        '"renderReviewDetails"->>\'error\' LIKE \'ConnectError:%%\' '
        'OR "renderReviewDetails"->>\'error\' LIKE \'sidecar_timeout:%%\' '
        'OR "renderReviewDetails"->>\'error\' = \'node_not_found\' '
        'OR "renderReviewDetails"->>\'error\' LIKE \'script_not_found:%%\' '
        'OR "renderReviewDetails"->>\'error\' = \'invalid_sidecar_payload\''
    )
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'WITH candidates AS ('
                'SELECT "id" FROM "summaries" '
                'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND "contentReviewStatus" IN (\'approved\', \'needs_manual_review\') '
                'AND "renderReviewStatus" = \'unavailable\' '
                'AND "renderReviewRound" < %s '
                'AND "renderReviewDetails"->>\'contentSha256\' '
                'IS NOT DISTINCT FROM "originalSha256" '
                'AND COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') = \'2.0\' '
                'AND COALESCE("originalMarkdown", \'\') <> \'\' '
                'AND (' + transient_error + ') '
                'ORDER BY "createdAt" ASC LIMIT %s FOR UPDATE SKIP LOCKED'
                ') UPDATE "summaries" SET '
                '"renderReviewStatus" = \'queued\', '
                '"renderReviewSummary" = jsonb_build_object('
                '\'status\', \'queued\', '
                '\'round\', "renderReviewRound", '
                '\'message\', \'sidecar 已恢复，重新执行浏览器审核。\', '
                '\'reason\', \'TRANSIENT_UNAVAILABLE_RETRY\'), '
                '"renderReviewDetails" = COALESCE("renderReviewDetails", \'{}\'::jsonb) '
                '|| jsonb_build_object('
                '\'status\', \'queued\', '
                '\'reason\', \'TRANSIENT_UNAVAILABLE_RETRY\', '
                '\'previousError\', "renderReviewDetails"->>\'error\'), '
                '"renderReviewedAt" = NULL, "updatedAt" = now() '
                'FROM candidates WHERE "summaries"."id" = candidates."id" '
                'RETURNING "summaries"."id"',
                (RENDER_REVIEW_TRANSIENT_MAX_ROUNDS, max(1, limit)),
            )
        ).fetchall()
    return len(rows)


async def run_review_reconciliation_once(
    pool: Any,
    *,
    limit: int | None = None,
) -> ReviewReconciliationResult:
    """Process a bounded batch and return auditable counters."""
    batch_limit = max(1, limit or _limit())
    quality_refreshed = await _refresh_stale_reader_quality(
        pool,
        limit=batch_limit,
    )
    candidate_ids = await _review_candidates(pool, limit=batch_limit)
    content_claimed = 0
    content_terminal = 0
    quality_manual = 0
    render_queued = 0
    for summary_id in candidate_ids:
        try:
            outcome = await review_enriched_summary(
                pool,
                summary_id=summary_id,
            )
        except Exception:
            logger.warning(
                "ai-engine.radar.review_reconciliation.summary_failed",
                extra={"summary_id": summary_id},
                exc_info=True,
            )
            continue
        if outcome is None:
            continue
        content_claimed += 1
        if outcome["content_status"] in {"approved", "needs_manual_review"}:
            content_terminal += 1
        if outcome["quality_manual"]:
            quality_manual += 1
        if outcome["render_queued"]:
            render_queued += 1

    render_queued += await _queue_missing_render_reviews(
        pool,
        limit=batch_limit,
    )
    render_queued += await _queue_transient_unavailable_render_reviews(
        pool,
        limit=batch_limit,
    )
    render_queued += await _queue_stale_render_reviews(
        pool,
        limit=batch_limit,
    )
    return ReviewReconciliationResult(
        candidates=len(candidate_ids) + quality_refreshed,
        content_claimed=content_claimed,
        content_terminal=content_terminal,
        quality_manual=quality_manual,
        render_queued=render_queued,
    )


async def review_reconciliation_loop(pool: Any) -> None:
    """Keep persisted high-value radar review state convergent."""
    interval = max(
        15.0,
        float(os.environ.get("RADAR_REVIEW_RECONCILIATION_INTERVAL_SECONDS", "60")),
    )
    batch_size = _limit()
    logger.info(
        "ai-engine.radar.review_reconciliation.started",
        extra={"interval_seconds": interval, "batch_size": batch_size},
    )
    while True:
        try:
            result = await run_review_reconciliation_once(
                pool,
                limit=batch_size,
            )
            if result.content_claimed == 0 and result.render_queued == 0:
                await asyncio.sleep(interval)
            else:
                logger.info(
                    "ai-engine.radar.review_reconciliation.completed",
                    extra=result.to_dict(),
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning(
                "ai-engine.radar.review_reconciliation.loop_failed",
                exc_info=True,
            )
            await asyncio.sleep(interval)


__all__ = [
    "ReviewReconciliationResult",
    "finalize_enrichment",
    "review_enriched_summary",
    "review_reconciliation_loop",
    "run_review_reconciliation_once",
]
