"""Post-process radar candidates that were created outside source syncs."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Awaitable, Callable

from ai_engine.radar.distilled_scorer import (
    DistilledScore,
    build_distilled_score_reason,
    score_with_llm,
)
from ai_engine.radar.sync_runner import _scoreability
from ai_engine.radar.sync_runner import _shell_content_label
from ai_engine.scoring.scoring_profiles import profile_for_source_url

logger = logging.getLogger("ai_engine.radar.candidate_postprocessor")

ScoreFn = Callable[..., Awaitable[DistilledScore]]

_SOURCE_PROFILE: dict[str, str] = {
    "arxiv": "paper",
    "github": "engineering",
    "github_trending": "engineering",
    "github_topic_search": "engineering",
    "devto": "engineering",
    "producthunt": "engineering",
    "rss": "news",
    "hackernews": "news",
    "reddit": "news",
    "lobsters": "news",
    "wechat": "news",
    "vendor_news": "news",
    "web_share": "news",
}


async def score_missing_candidates(
    pool: Any,
    *,
    limit: int = 50,
    summary_ids: tuple[str, ...] | None = None,
    rescore: bool = False,
    concurrency: int | None = None,
    scorer: ScoreFn = score_with_llm,
) -> int:
    """Score visible radar rows that have no persisted Distilled result.

    Source-sync candidates are normally scored inline. This fallback primarily
    covers approved user shares, while also repairing interrupted sync rows.
    Default/fallback scores are deliberately not persisted so a later run can
    retry the real LLM score.
    """
    async with pool.connection() as conn:
        summary_filter = ""
        params: tuple[Any, ...] = ()
        if summary_ids:
            placeholders = ",".join(["%s"] * len(summary_ids))
            summary_filter = f'AND s."id" IN ({placeholders}) '
            params = summary_ids
        score_filter = 's."distilledScore" IS NULL ' if not rescore else 'TRUE '
        summary_filter = summary_filter.removeprefix('AND ')
        where_prefix = 'WHERE ' + score_filter
        if summary_filter:
            where_prefix += 'AND ' + summary_filter
        rows = await (
            await conn.execute(
                'SELECT s."id", s."title", s."body", s."url", '
                's."publishedAt", s."originalMarkdown", s."tags", '
                'COALESCE(rs."sourceType", CASE WHEN s."source" = \'user\' '
                'THEN \'web_share\' ELSE \'rss\' END) AS "sourceType" '
                'FROM "summaries" s '
                'LEFT JOIN "radar_sync_runs" rr ON rr."id" = s."syncRunId" '
                'LEFT JOIN "radar_sources" rs ON rs."id" = rr."sourceId" '
                + where_prefix +
                'AND ((s."source" = \'daily\' AND s."syncRunId" IS NOT NULL) '
                'OR (s."source" = \'user\' AND s."status" IN '
                '(\'candidate\', \'published\') AND EXISTS ('
                'SELECT 1 FROM "share_submissions" sh '
                'WHERE sh."publishedSummaryId" = s."id" '
                'AND sh."status" = \'approved\'))) '
                'ORDER BY s."createdAt" ASC LIMIT %s',
                (*params, max(1, limit)),
            )
        ).fetchall()

    gate = asyncio.Semaphore(max(
        1,
        concurrency
        or int(os.environ.get("RADAR_SCORING_CONCURRENCY", "5")),
    ))

    async def _score(
        raw: Any,
    ) -> tuple[str, DistilledScore | None, str | None, str | None] | None:
        row = dict(raw)
        source_type = str(row.get("sourceType") or "web_share")
        profile, _ = profile_for_source_url(source_type, str(row.get("url") or ""))
        content = str(
            row.get("originalMarkdown")
            or row.get("body")
            or row.get("title")
            or ""
        )
        shell_label = _shell_content_label(
            content,
            source_type=source_type,
            url=str(row.get("url") or ""),
        )
        scoreability = _scoreability(content)
        if scoreability is None:
            logger.info(
                "ai-engine.radar.postprocess.score_deferred_incomplete_content",
                extra={"summary_id": str(row["id"]), "source_type": source_type},
            )
            return str(row["id"]), None, None, shell_label
        if scoreability == "limited":
            logger.info(
                "ai-engine.radar.postprocess.score_limited_content",
                extra={"summary_id": str(row["id"]), "source_type": source_type},
            )
        try:
            async with gate:
                result = await scorer(
                    str(row.get("title") or ""),
                    content,
                    profile=profile,
                    source_type=source_type,
                    url=str(row.get("url") or ""),
                    published_at=row.get("publishedAt"),
                )
        except Exception as exc:
            logger.warning(
                "ai-engine.radar.postprocess.score_failed",
                extra={"summary_id": str(row["id"]), "error": type(exc).__name__},
            )
            return None
        if result.is_default:
            return None
        return str(row["id"]), result, scoreability, shell_label

    results = await asyncio.gather(*(_score(row) for row in rows))
    persisted = 0
    async with pool.connection() as conn:
        for scored in results:
            if scored is None:
                continue
            summary_id, result, scoreability, shell_label = scored
            if result is None:
                pending_reason = (
                    "抓取失败: "
                    + shell_label
                    + " | 待重新抓取"
                    if shell_label
                    else None
                )
                await conn.execute(
                    'UPDATE "summaries" SET '
                    '"tags" = CASE '
                    'WHEN \'content_pending\' = ANY('
                    'COALESCE("tags", ARRAY[]::text[])) '
                    'AND \'fetch_failed_shell\' = ANY('
                    'COALESCE("tags", ARRAY[]::text[])) '
                    'THEN COALESCE("tags", ARRAY[]::text[]) '
                    'WHEN \'content_pending\' = ANY('
                    'COALESCE("tags", ARRAY[]::text[])) '
                    'THEN array_append(COALESCE("tags", ARRAY[]::text[]), '
                    '\'fetch_failed_shell\') '
                    'WHEN \'fetch_failed_shell\' = ANY('
                    'COALESCE("tags", ARRAY[]::text[])) '
                    'THEN array_append(COALESCE("tags", ARRAY[]::text[]), '
                    '\'content_pending\') '
                    'ELSE array_append('
                    'array_append(COALESCE("tags", ARRAY[]::text[]), '
                    '\'content_pending\'), \'fetch_failed_shell\') END, '
                    '"distilledScore" = NULL, "distilledTotal" = NULL, '
                    '"distilledTier" = NULL, '
                    '"distilledProfile" = NULL, "scoreReason" = %s, '
                    '"updatedAt" = now() WHERE "id" = %s',
                    (pending_reason, summary_id),
                )
                continue
            total = (
                result.tier_score
                if result.tier_score is not None
                else result.total
            )
            score_reason = build_distilled_score_reason(result)
            if scoreability == "limited":
                score_reason = (
                    "低置信度初筛：正文不足1000字符，仅用于排序和是否值得继续抓取。"
                    + score_reason
                )[:500]
            if shell_label:
                score_reason = (
                    "抓取失败: "
                    + shell_label
                    + " | "
                    + (score_reason or "")
                )[:500]
            if shell_label:
                tags_sql = (
                    "CASE WHEN 'fetch_failed_shell' = ANY("
                    'COALESCE("tags", ARRAY[]::text[])) '
                    "THEN array_remove(COALESCE(\"tags\", ARRAY[]::text[]), "
                    "'content_pending') "
                    "ELSE array_append("
                    "array_remove(COALESCE(\"tags\", ARRAY[]::text[]), "
                    "'content_pending'), 'fetch_failed_shell') END"
                )
            else:
                tags_sql = (
                    "array_remove("
                    "array_remove(COALESCE(\"tags\", ARRAY[]::text[]), "
                    "'content_pending'), 'fetch_failed_shell')"
                )
            await conn.execute(
                'UPDATE "summaries" SET "distilledScore" = %s::jsonb, '
                '"distilledTotal" = %s, "distilledTier" = %s, '
                '"distilledProfile" = %s, '
                '"scoreReason" = %s, '
                '"tags" = ' + tags_sql + ', '
                '"updatedAt" = now() WHERE "id" = %s',
                (
                    json.dumps(result.to_dict(), ensure_ascii=False),
                    total,
                    result.tier,
                    result.profile_id,
                    score_reason,
                    summary_id,
                ),
            )
            persisted += 1
    return persisted
