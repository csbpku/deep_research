"""Real-browser presentation review for enriched radar summaries.

The Markdown/content reviewer and this worker intentionally have different
responsibilities:

* ``content_reviewer`` checks the extracted document and may apply allow-listed
  text-only repairs.
* this worker opens the actual ``/radar/:id`` page in Playwright at desktop and
  mobile sizes and checks what a reader can really see.

Only ``collection`` and ``deep_read`` rows with a completed enrichment marker
and a terminal content review are eligible. Browser-review failures never
fail enrichment; they are persisted as ``unavailable`` or
``needs_manual_review`` so the content can be retried or repaired separately.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

logger = logging.getLogger("ai_engine.radar.render_review_worker")

RENDER_REVIEW_STATUSES = frozenset({
    "queued",
    "reviewing",
    "approved",
    "needs_manual_review",
    "unavailable",
})
RENDER_REVIEW_MAX_ROUNDS = 2


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def render_review_script() -> Path:
    configured = os.environ.get("RADAR_RENDER_REVIEW_SCRIPT")
    if configured:
        return Path(configured).expanduser()
    return _repo_root() / "apps" / "web" / "scripts" / "radar-render-review.mjs"


def render_review_enabled() -> bool:
    return os.environ.get("RADAR_RENDER_REVIEW_ENABLED", "1") == "1"


def _stale_review_minutes() -> int:
    try:
        return max(5, int(os.environ.get("RADAR_RENDER_REVIEW_STALE_MINUTES", "30")))
    except (TypeError, ValueError):
        return 30


def _json_object(value: object) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, Mapping):
        return dict(value)
    return None


async def queue_render_review(pool: Any, *, summary_id: str) -> bool:
    """Queue browser review only for a successfully enriched high-value row."""
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"renderReviewStatus" = \'queued\', '
            '"renderReviewRound" = 0, '
            '"renderReviewSummary" = NULL, '
            '"renderReviewDetails" = %s::jsonb, '
            '"renderReviewStartedAt" = NULL, '
            '"renderReviewClaimId" = NULL, '
            '"renderReviewedAt" = NULL, '
            '"updatedAt" = now() '
            'WHERE "id" = %s '
            'AND "distilledTier" IN (\'collection\', \'deep_read\') '
            'AND "contentReviewStatus" IN (\'approved\', \'needs_manual_review\') '
            'AND COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') = \'2.0\' '
            'AND COALESCE("originalMarkdown", \'\') <> \'\' '
            'RETURNING "id"',
            (
                json.dumps({
                    "stage": "render_review",
                    "status": "queued",
                    "reason": "enrichment_and_content_review_complete",
                }, ensure_ascii=False),
                summary_id,
            ),
        )
        row = await cursor.fetchone()
    return bool(row)


async def recover_stale_render_reviews(
    pool: Any,
    *,
    limit: int = 50,
) -> int:
    """Requeue stale browser claims, or close exhausted ones honestly."""
    stale_minutes = _stale_review_minutes()
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'WITH stale AS ('
                'SELECT "id" FROM "summaries" '
                'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND "renderReviewStatus" = \'reviewing\' '
                'AND ('
                '"renderReviewClaimId" IS NULL '
                'OR "renderReviewStartedAt" < now() - '
                f'make_interval(secs => {stale_minutes * 60})'
                ') '
                'ORDER BY "renderReviewStartedAt" ASC '
                'LIMIT %s FOR UPDATE SKIP LOCKED'
                ') '
                'UPDATE "summaries" AS s SET '
                '"renderReviewStatus" = CASE '
                f'WHEN s."renderReviewRound" >= {RENDER_REVIEW_MAX_ROUNDS} '
                'THEN \'unavailable\' ELSE \'queued\' END, '
                '"renderReviewSummary" = CASE '
                f'WHEN s."renderReviewRound" >= {RENDER_REVIEW_MAX_ROUNDS} '
                'THEN %s::jsonb ELSE %s::jsonb END, '
                '"renderReviewDetails" = CASE '
                f'WHEN s."renderReviewRound" >= {RENDER_REVIEW_MAX_ROUNDS} '
                'THEN %s::jsonb ELSE %s::jsonb END, '
                '"renderReviewStartedAt" = NULL, '
                '"renderReviewClaimId" = NULL, '
                '"renderReviewedAt" = CASE '
                f'WHEN s."renderReviewRound" >= {RENDER_REVIEW_MAX_ROUNDS} '
                'THEN now() ELSE NULL END, '
                '"updatedAt" = now() '
                'FROM stale WHERE s."id" = stale."id" '
                'AND s."renderReviewStatus" = \'reviewing\' '
                'RETURNING s."id"',
                (
                    max(1, limit),
                    json.dumps({
                        "status": "unavailable",
                        "message": "浏览器审核 worker lease 过期，已达到最大审核轮次。",
                        "reason": "WORKER_LOST",
                    }, ensure_ascii=False),
                    json.dumps({
                        "status": "queued",
                        "message": "浏览器审核 worker lease 过期，已重新排队。",
                        "reason": "WORKER_LOST",
                    }, ensure_ascii=False),
                    json.dumps({
                        "status": "unavailable",
                        "reason": "WORKER_LOST",
                    }, ensure_ascii=False),
                    json.dumps({
                        "status": "queued",
                        "reason": "WORKER_LOST",
                    }, ensure_ascii=False),
                ),
            )
        ).fetchall()
    if rows:
        logger.warning(
            "ai-engine.radar.render_review.stale_claims_recovered",
            extra={"count": len(rows)},
        )
    return len(rows)


async def retry_render_review(pool: Any, *, summary_id: str) -> bool:
    """Queue a repaired row for its next browser-review round.

    The round counter is intentionally preserved. A manual/code repair after
    round one therefore becomes round two instead of silently restarting an
    unbounded cycle.
    """
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"renderReviewStatus" = \'queued\', '
            '"renderReviewSummary" = NULL, '
            '"renderReviewDetails" = %s::jsonb, '
            '"renderReviewStartedAt" = NULL, '
            '"renderReviewClaimId" = NULL, '
            '"renderReviewedAt" = NULL, '
            '"updatedAt" = now() '
            'WHERE "id" = %s '
            'AND "distilledTier" IN (\'collection\', \'deep_read\') '
            'AND "renderReviewStatus" = \'needs_manual_review\' '
            'AND "renderReviewRound" < %s '
            'RETURNING "id"',
            (
                json.dumps({
                    "stage": "render_review",
                    "status": "queued",
                    "reason": "repair_completed",
                }, ensure_ascii=False),
                summary_id,
                RENDER_REVIEW_MAX_ROUNDS,
            ),
        )
        row = await cursor.fetchone()
    return bool(row)


async def _claim_next(pool: Any) -> tuple[str, int, str | None, str] | None:
    """Claim one queued row, recovering a stale browser worker lease."""
    stale_minutes = _stale_review_minutes()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"renderReviewStatus" = \'reviewing\', '
            '"renderReviewRound" = "renderReviewRound" + 1, '
            '"renderReviewStartedAt" = now(), '
            '"renderReviewClaimId" = gen_random_uuid(), '
            '"updatedAt" = now() '
            'WHERE "id" = ('
            'SELECT "id" FROM "summaries" '
            'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
            'AND "contentReviewStatus" IN (\'approved\', \'needs_manual_review\') '
            'AND COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') = \'2.0\' '
            'AND COALESCE("originalMarkdown", \'\') <> \'\' '
            'AND "renderReviewRound" < %s '
            'AND ('
            '"renderReviewStatus" = \'queued\' '
            'OR ('
            '"renderReviewStatus" = \'reviewing\' '
            'AND "renderReviewStartedAt" < now() - make_interval(secs => %s)'
            ')'
            ') '
            'ORDER BY "createdAt" ASC '
            'FOR UPDATE SKIP LOCKED LIMIT 1'
            ') '
            'RETURNING "id", "renderReviewRound", "originalSha256", '
            '"renderReviewClaimId"',
            (RENDER_REVIEW_MAX_ROUNDS, stale_minutes * 60),
        )
        row = await cursor.fetchone()
    if not row:
        return None
    return (
        str(row["id"]),
        int(row["renderReviewRound"]),
        str(row["originalSha256"]) if row["originalSha256"] is not None else None,
        str(row["renderReviewClaimId"]),
    )


def _parse_worker_output(stdout: bytes) -> dict[str, Any] | None:
    text = stdout.decode("utf-8", errors="replace").strip()
    if not text:
        return None
    for line in reversed(text.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        parsed = _json_object(value)
        if parsed is not None:
            return parsed
    return None


async def _run_browser_script(
    *,
    summary_id: str,
    round_number: int,
) -> dict[str, Any]:
    script = render_review_script()
    node = shutil.which(os.environ.get("RADAR_RENDER_REVIEW_NODE", "node"))
    if node is None:
        return {
            "status": "unavailable",
            "summary": "找不到 Node.js，未执行真实浏览器审核。",
            "error": "node_not_found",
        }
    if not script.is_file():
        return {
            "status": "unavailable",
            "summary": "浏览器审核脚本不存在，未执行真实页面审核。",
            "error": f"script_not_found:{script}",
        }

    base_url = os.environ.get(
        "RADAR_RENDER_REVIEW_BASE_URL",
        "http://127.0.0.1:3000",
    )
    timeout_seconds = max(
        30,
        int(os.environ.get("RADAR_RENDER_REVIEW_TIMEOUT_SECONDS", "150")),
    )
    command = [
        node,
        str(script),
        "--summary-id",
        summary_id,
        "--round",
        str(round_number),
        "--base-url",
        base_url,
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(_repo_root()),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        return {
            "status": "unavailable",
            "summary": "真实浏览器审核超时，内容仍需人工复核页面。",
            "error": f"timeout:{timeout_seconds}s",
        }
    except OSError as exc:
        return {
            "status": "unavailable",
            "summary": "无法启动真实浏览器审核。",
            "error": f"{type(exc).__name__}:{str(exc)[:200]}",
        }

    result = _parse_worker_output(stdout)
    if result is not None:
        result.setdefault("exitCode", process.returncode)
        if stderr:
            result.setdefault(
                "stderr",
                stderr.decode("utf-8", errors="replace")[-2000:],
            )
        return result
    return {
        "status": "unavailable",
        "summary": "浏览器审核没有返回结构化结果。",
        "error": (
            f"exit_code={process.returncode}; "
            f"stderr={stderr.decode('utf-8', errors='replace')[-500:]}"
        ),
    }


async def _persist_result(
    pool: Any,
    *,
    summary_id: str,
    round_number: int,
    claim_id: str,
    expected_sha256: str | None,
    result: dict[str, Any],
) -> str | None:
    status = str(result.get("status") or "unavailable")
    if status not in RENDER_REVIEW_STATUSES:
        status = "unavailable"
    summary = {
        "status": status,
        "round": round_number,
        "message": str(result.get("summary") or "")[:1000],
    }
    details = dict(result)
    details["round"] = round_number
    details["contentSha256"] = expected_sha256
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"renderReviewStatus" = %s, '
            '"renderReviewSummary" = %s::jsonb, '
            '"renderReviewDetails" = %s::jsonb, '
            '"renderReviewedAt" = CASE WHEN %s IN '
            '(\'approved\', \'needs_manual_review\', \'unavailable\') '
            'THEN now() ELSE "renderReviewedAt" END, '
            '"renderReviewStartedAt" = NULL, '
            '"renderReviewClaimId" = NULL, '
            '"updatedAt" = now() WHERE "id" = %s '
            'AND "renderReviewStatus" = \'reviewing\' '
            'AND "renderReviewRound" = %s '
            'AND "renderReviewClaimId" = %s::uuid '
            'AND "originalSha256" IS NOT DISTINCT FROM %s '
            'RETURNING "id"',
            (
                status,
                json.dumps(summary, ensure_ascii=False),
                json.dumps(details, ensure_ascii=False),
                status,
                summary_id,
                round_number,
                claim_id,
                expected_sha256,
            ),
        )
        row = await cursor.fetchone()
    if row is None:
        logger.info(
            "ai-engine.radar.render_review.stale_result_discarded",
            extra={"summary_id": summary_id, "round": round_number},
        )
        return None
    return status


async def run_render_review_once(pool: Any, *, limit: int = 1) -> dict[str, int]:
    """Review a bounded batch. This is safe to run beside enrichment."""
    if not render_review_enabled():
        return {"claimed": 0, "approved": 0, "manual": 0, "unavailable": 0}

    await recover_stale_render_reviews(pool, limit=max(limit, 50))
    counts = {"claimed": 0, "approved": 0, "manual": 0, "unavailable": 0}
    for _ in range(max(1, limit)):
        claimed = await _claim_next(pool)
        if claimed is None:
            break
        summary_id, round_number, expected_sha256, claim_id = claimed
        counts["claimed"] += 1
        result = await _run_browser_script(
            summary_id=summary_id,
            round_number=round_number,
        )
        status = await _persist_result(
            pool,
            summary_id=summary_id,
            round_number=round_number,
            claim_id=claim_id,
            expected_sha256=expected_sha256,
            result=result,
        )
        if status is None:
            continue
        if status == "approved":
            counts["approved"] += 1
        elif status == "needs_manual_review":
            counts["manual"] += 1
        else:
            counts["unavailable"] += 1
    return counts


async def render_review_loop(pool: Any) -> None:
    """Poll queued high-value enrichments without blocking the radar pipeline."""
    interval = max(
        10.0,
        float(os.environ.get("RADAR_RENDER_REVIEW_INTERVAL_SECONDS", "30")),
    )
    limit = max(
        1,
        int(os.environ.get("RADAR_RENDER_REVIEW_BATCH_SIZE", "1")),
    )
    logger.info(
        "ai-engine.radar.render_review.started",
        extra={"interval_seconds": interval, "batch_size": limit},
    )
    while True:
        try:
            result = await run_render_review_once(pool, limit=limit)
            if result["claimed"] == 0:
                await asyncio.sleep(interval)
            else:
                logger.info(
                    "ai-engine.radar.render_review.completed",
                    extra=result,
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning(
                "ai-engine.radar.render_review.loop_failed",
                exc_info=True,
            )
            await asyncio.sleep(interval)


__all__ = [
    "RENDER_REVIEW_MAX_ROUNDS",
    "queue_render_review",
    "retry_render_review",
    "render_review_enabled",
    "render_review_loop",
    "run_render_review_once",
]
