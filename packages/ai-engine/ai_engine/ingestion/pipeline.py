"""Daily source ingestion through the shared research-engine adapter."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from ai_engine.adapters.base import ResearchEngineAdapter, ResearchRequest, build_adapter
from ai_engine.contracts.states import AI_JOB_STATUS
from ai_engine.ingestion.sources import fetch_arxiv, fetch_rss_feeds
from ai_engine.job_runner.db_store import AI_TABLE, DbJobStore

logger = logging.getLogger("ai_engine.ingestion.pipeline")
FetchRss = Callable[..., Awaitable[list[dict[str, Any]]]]
FetchArxiv = Callable[..., Awaitable[list[dict[str, Any]]]]
_TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid"}


@dataclass
class IngestionResult:
    run_id: str
    sources_attempted: int = 0
    sources_succeeded: int = 0
    sources_failed: int = 0
    summaries_inserted: int = 0
    duplicates_skipped: int = 0
    generation_failed: int = 0
    token_input_total: int = 0
    token_output_total: int = 0
    cost_cents: int = 0
    duration_ms: int = 0
    errors: list[str] = field(default_factory=list)
    sample_urls: list[str] = field(default_factory=list)
    run_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


def canonicalize_url(value: str) -> str:
    parts = urlsplit(value.strip())
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        return ""
    query = urlencode([
        (key, item)
        for key, item in parse_qsl(parts.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in _TRACKING_PARAMS
    ])
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, query, ""))


async def _generate_brief(
    adapter: ResearchEngineAdapter,
    item: dict[str, Any],
    canonical_url: str,
    *,
    timeout_seconds: float,
) -> Any:
    job_id = str(uuid.uuid4())
    request = ResearchRequest(
        job_id=job_id,
        request_id=f"ingestion-{job_id}",
        topic=str(item.get("title") or "Untitled")[:200],
        context=str(item.get("snippet") or "")[:2000] or None,
        report_type="summary_brief",
        source_policy="only_user_sources",
        source_refs=({"type": "url", "value": canonical_url},),
        timeout_seconds=max(1, int(timeout_seconds)),
    )
    await adapter.submit(request)
    deadline = time.monotonic() + timeout_seconds
    while True:
        status = await adapter.get_status(job_id)
        if status.status in {
            AI_JOB_STATUS["SUCCEEDED"], AI_JOB_STATUS["PARTIAL"],
            AI_JOB_STATUS["FAILED"], AI_JOB_STATUS["CANCELLED"],
        }:
            return status
        if time.monotonic() >= deadline:
            await adapter.cancel(job_id)
            return await adapter.get_status(job_id)
        await asyncio.sleep(0.01)


async def run_ingestion(
    pool: Any,
    *,
    max_total: int = 4,
    rss_per_feed: int = 2,
    arxiv_count: int = 2,
    rss_urls: list[str] | None = None,
    summary_date: date | None = None,
    adapter: ResearchEngineAdapter | None = None,
    fetch_rss: FetchRss = fetch_rss_feeds,
    fetch_arxiv_items: FetchArxiv = fetch_arxiv,
    generation_timeout_seconds: float = 60.0,
) -> IngestionResult:
    """Fetch source batches, generate briefs, and publish successful summaries."""
    started = time.monotonic()
    result = IngestionResult(run_id=str(uuid.uuid4())[:8], sources_attempted=2)
    summary_date = summary_date or datetime.now(timezone.utc).date()
    engine = adapter or build_adapter()

    async def fetch_batch(name: str, call: Awaitable[list[dict[str, Any]]]) -> list[dict[str, Any]]:
        try:
            items = await call
            result.sources_succeeded += 1
            return items
        except Exception as exc:
            result.sources_failed += 1
            result.errors.append(f"{name}: {type(exc).__name__}")
            logger.warning("ai-engine.ingestion.source_failed", extra={"source": name})
            return []

    rss_items, arxiv_items = await asyncio.gather(
        fetch_batch("rss", fetch_rss(rss_urls, max_per_feed=rss_per_feed)),
        fetch_batch("arxiv", fetch_arxiv_items(max_results=arxiv_count)),
    )
    seen: set[str] = set()
    items: list[tuple[dict[str, Any], str]] = []
    for item in rss_items + arxiv_items:
        canonical_url = canonicalize_url(str(item.get("url") or ""))
        if canonical_url and canonical_url not in seen:
            seen.add(canonical_url)
            items.append((item, canonical_url))
        if len(items) >= max_total:
            break

    for item, canonical_url in items:
        try:
            status = await _generate_brief(
                engine, item, canonical_url, timeout_seconds=generation_timeout_seconds
            )
            result.token_input_total += status.cost.token_input_total
            result.token_output_total += status.cost.token_output_total
            result.cost_cents += status.cost.cost_cents
            if status.status != AI_JOB_STATUS["SUCCEEDED"] or not status.output_text:
                result.generation_failed += 1
                result.errors.append(f"generate({canonical_url[:80]}): {status.status}")
                continue
            body = status.output_text.strip()
            sql = (
                'INSERT INTO "summaries" '
                '("id", "title", "body", "url", "canonicalUrl", "source", "contentOrigin", '
                '"summaryDate", "publishedAt", "contentSha256", "ingestionTokenCount", '
                '"tags", "status", "createdAt", "updatedAt") '
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), %s, %s, %s::text[], "
                "'published', now(), now()) ON CONFLICT (\"canonicalUrl\") DO NOTHING RETURNING \"id\""
            )
            params = (
                str(uuid.uuid4()), str(item.get("title") or "Untitled")[:300], body,
                canonical_url[:2048], canonical_url[:2048], item.get("source", "daily"),
                item.get("content_origin", "api"), summary_date,
                hashlib.sha256(body.encode("utf-8")).hexdigest(),
                status.cost.token_input_total + status.cost.token_output_total,
                item.get("tags", ["daily"]),
            )
            async with pool.connection() as conn:
                async with conn.transaction():
                    row = await (await conn.execute(sql, params)).fetchone()
            if row is None:
                result.duplicates_skipped += 1
            else:
                result.summaries_inserted += 1
                result.sample_urls.append(canonical_url)
        except Exception as exc:
            result.generation_failed += 1
            result.errors.append(f"item({canonical_url[:80]}): {type(exc).__name__}")
            logger.warning("ai-engine.ingestion.item_failed", extra={"url": canonical_url[:100]})

    result.duration_ms = int((time.monotonic() - started) * 1000)
    logger.info(
        "ai-engine.ingestion.done",
        extra={
            "run_id": result.run_id,
            "inserted": result.summaries_inserted,
            "duplicates": result.duplicates_skipped,
            "generation_failed": result.generation_failed,
            "token_input_total": result.token_input_total,
            "token_output_total": result.token_output_total,
            "cost_cents": result.cost_cents,
            "duration_ms": result.duration_ms,
        },
    )
    return result


async def run_ingestion_once() -> IngestionResult:
    store = DbJobStore(table_name=AI_TABLE)
    async with store:
        return await run_ingestion(store.pool)


if __name__ == "__main__":  # pragma: no cover
    print(asyncio.run(run_ingestion_once()))
