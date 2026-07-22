"""Ingestion pipeline — writes fetched items to summaries table.

Uses DbJobStore's pool to INSERT summaries with ON CONFLICT (canonicalUrl) DO NOTHING
for idempotent dedup. Each run selects 4 items from RSS + Arxiv.

W3: real ingestion (摘要注入 + 来源抓取), integreated with DbJobStore pool.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

from ai_engine.ingestion.sources import fetch_arxiv, fetch_rss_feeds

logger = logging.getLogger("ai_engine.ingestion.pipeline")


@dataclass
class IngestionResult:
    """Summary of one ingestion run."""

    run_id: str
    sources_attempted: int = 0
    sources_succeeded: int = 0
    sources_failed: int = 0
    summaries_inserted: int = 0
    duplicates_skipped: int = 0
    errors: list[str] = field(default_factory=list)
    sample_urls: list[str] = field(default_factory=list)
    run_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


async def run_ingestion(
    pool: Any,
    *,
    max_total: int = 4,
    rss_per_feed: int = 2,
    arxiv_count: int = 2,
    rss_urls: list[str] | None = None,
    summary_date: date | None = None,
) -> IngestionResult:
    """Fetch RSS + Arxiv, then INSERT into summaries table.

    Args:
        pool: psycopg AsyncConnectionPool (from DbJobStore._pool or standalone).
        max_total: max summaries to insert (cap after combining both sources).
        rss_per_feed: max items per RSS feed.
        arxiv_count: max arxiv results.
        rss_urls: optional RSS feed URLs (default: HN + TechCrunch).
        summary_date: date for the summary_date column (default = today UTC).

    Returns IngestionResult with counts and sample URLs.
    """
    run_id = str(uuid.uuid4())[:8]
    result = IngestionResult(run_id=run_id)
    if summary_date is None:
        summary_date = date.today()

    # 1. Fetch from all sources in parallel
    rss_results: list[dict[str, Any]] = []
    arxiv_results: list[dict[str, Any]] = []

    try:
        rss_results = await fetch_rss_feeds(rss_urls, max_per_feed=rss_per_feed)
        result.sources_attempted += len(rss_results) if rss_results else 0
        result.sources_succeeded += len(rss_results) if rss_results else 0
    except Exception as exc:
        logger.warning("ai-engine.ingestion.rss_batch_failed", extra={"error": str(exc)[:200]})
        result.sources_failed += 1
        result.errors.append(f"rss: {type(exc).__name__}")

    try:
        arxiv_results = await fetch_arxiv(max_results=arxiv_count)
        result.sources_attempted += len(arxiv_results) if arxiv_results else 0
        result.sources_succeeded += len(arxiv_results) if arxiv_results else 0
    except Exception as exc:
        logger.warning("ai-engine.ingestion.arxiv_batch_failed", extra={"error": str(exc)[:200]})
        result.sources_failed += 1
        result.errors.append(f"arxiv: {type(exc).__name__}")

    # 2. Combine and cap at max_total
    all_items = (rss_results or []) + (arxiv_results or [])
    items_to_insert = all_items[:max_total]
    logger.info(
        "ai-engine.ingestion.combined",
        extra={
            "run_id": run_id,
            "total_fetched": len(all_items),
            "inserting": len(items_to_insert),
            "rss": len(rss_results or []),
            "arxiv": len(arxiv_results or []),
        },
    )

    # 3. INSERT into summaries table (ON CONFLICT canonicalUrl DO NOTHING)
    for item in items_to_insert:
        canonical_url = item.get("url", "")
        if not canonical_url:
            continue

        try:
            summary_id = str(uuid.uuid4())
            sql = (
                'INSERT INTO "summaries" '
                '("id", "title", "body", "url", "canonicalUrl", "source", "contentOrigin", '
                '"summaryDate", "tags", "status", "createdAt", "updatedAt") '
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::text[], %s, now(), now()) "
                'ON CONFLICT ("canonicalUrl") DO NOTHING '
                "RETURNING \"id\""
            )
            params = (
                summary_id,
                item.get("title", "Untitled")[:300],
                item.get("snippet", "")[:2000],
                canonical_url[:2048],
                canonical_url[:2048],
                item.get("source", "daily"),
                item.get("content_origin", "api"),
                summary_date,
                item.get("tags", ["daily"]),
                "candidate",
            )
            async with pool.connection() as conn:
                async with conn.transaction():
                    cur = await conn.execute(sql, params)
                    row = await cur.fetchone()
                    if row is not None:
                        result.summaries_inserted += 1
                        result.sample_urls.append(canonical_url)
                    else:
                        result.duplicates_skipped += 1
                        logger.info(
                            "ai-engine.ingestion.duplicate_skipped",
                            extra={"canonical_url": canonical_url[:100]},
                        )
        except Exception as exc:
            logger.warning(
                "ai-engine.ingestion.insert_error",
                extra={"url": canonical_url[:100], "error": str(exc)[:300]},
            )
            result.errors.append(f"insert({canonical_url[:80]}): {type(exc).__name__}")

    logger.info(
        "ai-engine.ingestion.done",
        extra={
            "run_id": run_id,
            "inserted": result.summaries_inserted,
            "duplicates": result.duplicates_skipped,
            "errors": len(result.errors),
        },
    )
    return result
