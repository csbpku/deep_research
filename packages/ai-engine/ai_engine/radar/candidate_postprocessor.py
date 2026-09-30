"""Post-process radar candidates that were created outside source syncs."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Any, Awaitable, Callable

from ai_engine.radar.distilled_scorer import (
    DistilledScore,
    build_distilled_score_reason,
    score_with_llm,
)
from ai_engine.radar.models import RadarCandidate
from ai_engine.radar.sync_runner import _github_repo_signals, _scoreability
from ai_engine.radar.sync_runner import _shell_content_label
from ai_engine.radar.enrichment_contract import (
    effective_tier,
    is_enrichment_ready,
    is_enrichment_tier,
)
from ai_engine.scoring.scoring_profiles import profile_for_source_url

logger = logging.getLogger("ai_engine.radar.candidate_postprocessor")

ScoreFn = Callable[..., Awaitable[DistilledScore]]
ScoreInputFn = Callable[[Any, dict[str, Any]], Awaitable[tuple[str, str] | None]]

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


def _repo_signals_from_row(row: dict[str, Any], content: str) -> dict[str, Any]:
    """Rebuild auditable GitHub evidence after enrichment.

    Inline source scoring has the fetcher's repo signals available, while
    post-enrichment rescoring only has the persisted repository metadata. Keep
    the same signal shape in both paths so a real README/Zread snapshot can
    replace the initial landing-page triage score.
    """
    meta = row.get("originalMeta")
    base: dict[str, Any] = {}
    if isinstance(meta, dict):
        for key in ("stars", "starsToday", "forks", "openIssues"):
            value = meta.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                base[key] = value
        tree = meta.get("tree")
        if isinstance(tree, list):
            paths = [
                str(node.get("path") or "").lower()
                for node in tree
                if isinstance(node, dict)
            ]
            base["hasTests"] = any(
                "test" in path or "spec" in path for path in paths
            )
            base["hasCiAction"] = any(
                ".github/workflows/" in path for path in paths
            )
            base["hasArchitecture"] = any(
                token in path
                for path in paths
                for token in ("src/", "lib/", "pkg/", "internal/", "architecture")
            )
    candidate = RadarCandidate(
        title=str(row.get("title") or ""),
        url=str(row.get("url") or ""),
        repo_signals=base,
    )
    return _github_repo_signals(candidate, content)


async def score_missing_candidates(
    pool: Any,
    *,
    limit: int = 50,
    summary_ids: tuple[str, ...] | None = None,
    sync_run_ids: tuple[str, ...] | None = None,
    original_fetched_since: datetime | None = None,
    rescore: bool = False,
    suppress_enrichment: bool = False,
    concurrency: int | None = None,
    scorer: ScoreFn = score_with_llm,
    only_unscored: bool = False,
    transient_input: ScoreInputFn | None = None,
    include_archived: bool = False,
) -> int:
    """Score visible radar rows that have no persisted Distilled result.

    Source-sync candidates are normally scored inline. This fallback primarily
    covers approved user shares, while also repairing interrupted sync rows.
    Default/fallback scores are deliberately not persisted so a later run can
    retry the real LLM score. During an explicit re-score, rows that cannot be
    scored keep their existing score. ``suppress_enrichment`` lets maintenance
    jobs update scores without queueing server-side reading assets.
    """
    async with pool.connection() as conn:
        summary_filter = ""
        params: tuple[Any, ...] = ()
        if summary_ids:
            placeholders = ",".join(["%s"] * len(summary_ids))
            summary_filter = f'AND s."id" IN ({placeholders}) '
            params = summary_ids
        if sync_run_ids:
            placeholders = ",".join(["%s"] * len(sync_run_ids))
            summary_filter += f'AND s."syncRunId" IN ({placeholders}) '
            params += sync_run_ids
        if original_fetched_since is not None:
            summary_filter += 'AND s."originalFetchedAt" >= %s '
            params += (original_fetched_since,)
        score_filter = (
            's."distilledScore" IS NULL '
            if only_unscored
            else (
                '(s."distilledScore" IS NULL OR COALESCE(s."tags", ARRAY[]::text[]) '
                "@> ARRAY['score_pending_after_enrichment']::text[]) "
                if not rescore
                else 'TRUE '
            )
        )
        summary_filter = summary_filter.removeprefix('AND ')
        where_prefix = 'WHERE ' + score_filter
        if summary_filter:
            where_prefix += 'AND ' + summary_filter
        statuses = (
            "('candidate', 'published', 'archived')"
            if include_archived else "('candidate', 'published')"
        )
        rows = await (
            await conn.execute(
                'SELECT s."id", s."title", s."body", s."interpretation", s."url", s."status", '
                's."source", s."syncRunId", s."canonicalUrl", '
                's."publishedAt", s."originalMarkdown", s."tags", '
                's."originalKind", s."originalMeta", s."enrichmentStatus", '
                's."readerQualityStatus", '
                'COALESCE(rs."sourceType", CASE WHEN s."source" = \'user\' '
                'THEN \'web_share\' ELSE \'rss\' END) AS "sourceType" '
                'FROM "summaries" s '
                'LEFT JOIN "radar_sync_runs" rr ON rr."id" = s."syncRunId" '
                'LEFT JOIN "radar_sources" rs ON rs."id" = rr."sourceId" '
                + where_prefix +
                f'AND s."status" IN {statuses} '
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
    ) -> tuple[
        str,
        DistilledScore | None,
        str | None,
        str | None,
        str | None,
        bool,
        bool,
        bool,
        bool,
        str | None,
    ] | None:
        row = dict(raw)
        external_reading = "external_reading" in (row.get("tags") or [])
        archived = include_archived and row.get("status") == "archived"
        if archived and str(row.get("title") or "").lower().startswith("hacked by"):
            return None
        source_type = str(row.get("sourceType") or "web_share")
        original_kind = str(row.get("originalKind") or "")
        is_repo = original_kind == "github_repo" or str(
            row.get("url") or ""
        ).lower().startswith("https://github.com/")
        scoring_source_type = "github" if is_repo else source_type
        profile, _ = profile_for_source_url(
            scoring_source_type,
            str(row.get("url") or ""),
        )
        content = str(
            (row.get("interpretation") if external_reading else None)
            or row.get("originalMarkdown")
            or row.get("body")
            or row.get("title")
            or ""
        )
        input_kind: str | None = None
        if transient_input is not None and (external_reading or archived):
            try:
                async with gate:
                    resolved = await transient_input(pool, row)
            except Exception as exc:
                logger.warning(
                    "ai-engine.radar.postprocess.transient_input_failed",
                    extra={"summary_id": str(row["id"]), "error": type(exc).__name__},
                )
                resolved = None
            if resolved is not None:
                content, input_kind = resolved
            else:
                return None
        shell_label = None if external_reading else _shell_content_label(
            content,
            source_type=source_type,
            url=str(row.get("url") or ""),
        )
        scoreability = _scoreability(content)
        if scoreability is None:
            if row.get("status") == "archived":
                return None
            if external_reading:
                logger.info(
                    "ai-engine.radar.postprocess.metadata_insufficient_for_score",
                    extra={"summary_id": str(row["id"]), "source_type": source_type},
                )
                return None
            logger.info(
                "ai-engine.radar.postprocess.score_deferred_incomplete_content",
                extra={"summary_id": str(row["id"]), "source_type": source_type},
            )
            return (
                str(row["id"]),
                None,
                None,
                shell_label,
                None,
                False,
                external_reading,
                external_reading or suppress_enrichment,
                suppress_enrichment,
                input_kind,
            )
        if external_reading:
            # Even a long provider abstract is not the full source document.
            scoreability = "limited"
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
                    source_type=scoring_source_type,
                    url=str(row.get("url") or ""),
                    published_at=row.get("publishedAt"),
                    structured_signals=(
                        _repo_signals_from_row(row, content)
                        if is_repo
                        else None
                    ),
                )
        except Exception as exc:
            logger.warning(
                "ai-engine.radar.postprocess.score_failed",
                extra={"summary_id": str(row["id"]), "error": type(exc).__name__},
            )
            return None
        if result.is_default:
            return None
        enrichment_ready = is_enrichment_ready(
            enrichment_status=row.get("enrichmentStatus"),
            reader_quality_status=row.get("readerQualityStatus"),
            original_kind=row.get("originalKind") or source_type,
            original_meta=row.get("originalMeta"),
        )
        deliverable_tier = effective_tier(
            result.tier,
            enrichment_ready=enrichment_ready,
            external_reading=external_reading or suppress_enrichment,
        )
        return (
            str(row["id"]),
            result,
            scoreability,
            shell_label,
            deliverable_tier,
            enrichment_ready,
            external_reading,
            external_reading or suppress_enrichment,
            suppress_enrichment,
            input_kind,
        )

    results = await asyncio.gather(*(_score(row) for row in rows))
    persisted = 0
    async with pool.connection() as conn:
        for scored in results:
            if scored is None:
                continue
            (
                summary_id,
                result,
                scoreability,
                shell_label,
                deliverable_tier,
                enrichment_ready,
                external_reading,
                no_enrichment,
                preserve_enrichment_state,
                input_kind,
            ) = scored
            if result is None:
                if rescore:
                    logger.info(
                        "ai-engine.radar.postprocess.rescore_skipped_incomplete_content",
                        extra={"summary_id": summary_id},
                    )
                    continue
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
                    '"distilledTargetTier" = NULL, '
                    '"enrichmentStatus" = NULL, "enrichmentNextRetryAt" = NULL, '
                    '"distilledProfile" = NULL, "scoreReason" = %s, '
                    '"updatedAt" = now() WHERE "id" = %s'
                    + (' AND "distilledScore" IS NULL' if only_unscored else ''),
                    (pending_reason, summary_id),
                )
                continue
            total = (
                result.tier_score
                if result.tier_score is not None
                else result.total
            )
            score_reason = build_distilled_score_reason(result)
            if external_reading or input_kind is not None:
                evidence_label = (
                    "临时读取的来源正文" if input_kind == "transient_source"
                    else "临时读取的原站摘要" if input_kind == "source_abstract"
                    else "来源摘录" if input_kind == "source_excerpt"
                    else "已生成摘要/来源摘录"
                )
                score_reason = (
                    f"补评分：全文未缓存，依据{evidence_label}；请打开原文复核。"
                    + score_reason
                )[:500]
            elif scoreability == "limited":
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
                # A shell page is scoreable enough for triage, but it is not
                # the requested source content. Keep that fact visible to
                # operators and remove the generic pending marker once the
                # more precise diagnostic tag is present.
                tags_sql = (
                    "ARRAY(SELECT tag FROM unnest(COALESCE(\"tags\", ARRAY[]::text[])) AS tag "
                    "WHERE tag NOT LIKE 'tier_%%' "
                    "AND tag NOT IN ('content_pending', 'fetch_failed_shell', "
                    "'score_pending_after_enrichment')) "
                    "|| ARRAY['fetch_failed_shell', 'tier_' || %s]::text[]"
                )
            else:
                tags_sql = (
                    "ARRAY(SELECT tag FROM unnest(COALESCE(\"tags\", ARRAY[]::text[])) AS tag "
                    "WHERE tag NOT LIKE 'tier_%%' "
                    "AND tag NOT IN ('content_pending', 'fetch_failed_shell', "
                    "'score_pending_after_enrichment')) "
                    "|| ARRAY['tier_' || %s]::text[]"
                )
            cursor = await conn.execute(
                'UPDATE "summaries" SET "distilledScore" = %s::jsonb, '
                '"distilledTotal" = %s, "distilledTier" = %s, '
                '"distilledTargetTier" = %s, '
                '"distilledProfile" = %s, '
                '"scoreReason" = %s, '
                '"enrichmentStatus" = CASE '
                'WHEN %s THEN "enrichmentStatus" '
                'WHEN %s THEN NULL '
                'WHEN %s::text IS NULL THEN NULL '
                'WHEN %s THEN \'ready\' ELSE \'pending\' END, '
                '"enrichmentNextRetryAt" = CASE '
                'WHEN %s THEN "enrichmentNextRetryAt" '
                'WHEN %s OR %s::text IS NULL OR %s THEN NULL ELSE now() END, '
                '"tags" = ' + tags_sql + ', '
                '"updatedAt" = now() WHERE "id" = %s'
                + (' AND "distilledScore" IS NULL' if only_unscored else ''),
                (
                    json.dumps(result.to_dict(), ensure_ascii=False),
                    total,
                    deliverable_tier,
                    result.tier if is_enrichment_tier(result.tier) else None,
                    result.profile_id,
                    score_reason,
                    preserve_enrichment_state,
                    no_enrichment,
                    result.tier if is_enrichment_tier(result.tier) else None,
                    enrichment_ready,
                    preserve_enrichment_state,
                    no_enrichment,
                    result.tier if is_enrichment_tier(result.tier) else None,
                    enrichment_ready,
                    deliverable_tier or "skim",
                    summary_id,
                ),
            )
            if not only_unscored or cursor.rowcount > 0:
                persisted += 1
    return persisted
