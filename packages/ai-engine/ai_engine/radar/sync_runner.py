"""Technical radar synchronization runner.

Each enabled source owns one ``radar_sync_runs`` row. Source and candidate
failures are isolated, and the source run records counts/cost without ever
publishing candidates automatically.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from typing import Any, cast
from urllib.parse import urlsplit

from ai_engine.adapters.base import CostMetrics, ResearchEngineAdapter, build_adapter
from ai_engine.contracts.states import AI_JOB_STATUS
from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError, safe_fetch
from ai_engine.ingestion.pipeline import _generate_brief
from ai_engine.radar.models import RadarCandidate, RadarSource
from ai_engine.radar.pipeline import normalize_candidate, score_candidate
from ai_engine.radar.source_manager import SourceFetcher, fetch_source, load_enabled_sources
from ai_engine.server.share import _infer_title, html_to_markdown

logger = logging.getLogger("ai_engine.radar.sync_runner")
BriefGenerator = Callable[..., Awaitable[Any]]
SafeFetcher = Callable[..., Awaitable[FetchedDocument]]


@dataclass(slots=True, frozen=True)
class SourceRunResult:
    run_id: str
    source_id: str
    status: str
    total_fetched: int
    total_new: int
    total_skipped: int
    total_failed: int
    token_input_total: int
    token_output_total: int
    cost_usd: float
    error_code: str | None = None


@dataclass(slots=True, frozen=True)
class RadarSyncResult:
    batch_id: str
    runs: tuple[SourceRunResult, ...]


def _host(value: str) -> str:
    return (urlsplit(value).hostname or "").lower()


def _cost_usd(cost: CostMetrics) -> float:
    return round(cost.cost_cents / 100.0, 6)


def _safe_error_code(exc: BaseException) -> str:
    """Map an exception raised in the source / candidate path to a contract code.

    Preserves the caller-visible root cause instead of collapsing every
    failure into ``AI_ENGINE_UNAVAILABLE``. We surface:
    - ``SafeFetchError`` codes (URL_FETCH_*, URL_REDIRECT_LIMIT) verbatim
    - ``asyncio.TimeoutError`` / ``TimeoutError`` → ``WORKER_TIMEOUT``
    - ``ValueError`` → ``VALIDATION_FAILED``
    - ``httpx.HTTPError`` → ``URL_FETCH_TIMEOUT`` (TimeoutException) or
      ``URL_FETCH_BLOCKED`` (everything else — DNS, connect, TLS, protocol)
    - ``RuntimeError`` raised by ``ingestion.sources.fetch_arxiv`` (prefix
      ``arxiv_*``) → specific codes so dashboards can split transport
      failures from rate-limit hits and parse errors
    - anything else → ``AI_ENGINE_UNAVAILABLE`` (genuine unknown)
    """
    if isinstance(exc, SafeFetchError):
        return exc.code
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "WORKER_TIMEOUT"
    if isinstance(exc, ValueError):
        return "VALIDATION_FAILED"
    # httpx errors surface from safe_fetch wrappers + the arxiv fetcher.
    # We import lazily to avoid pulling httpx into sync_runner tests.
    import httpx as _httpx

    if isinstance(exc, _httpx.TimeoutException):
        return "URL_FETCH_TIMEOUT"
    if isinstance(exc, (_httpx.ConnectError, _httpx.ConnectTimeout,
                        _httpx.NetworkError, _httpx.RemoteProtocolError)):
        return "URL_FETCH_BLOCKED"
    if isinstance(exc, _httpx.HTTPError):
        return "URL_FETCH_BLOCKED"
    # fetch_arxiv classifies its own failures with leading ``arxiv_*`` tags.
    msg = str(exc) or ""
    if msg.startswith("arxiv_"):
        tag = msg.split(":", 1)[0]
        # Translate the arxiv-specific tags to the public contract codes
        # so dashboards / alerts can group by HTTP-style semantics.
        if tag == "arxiv_timeout":
            return "WORKER_TIMEOUT"
        if tag == "arxiv_rate_limited":
            return "URL_FETCH_TOO_LARGE"  # closest pre-existing 4xx rate-limit code
        if tag == "arxiv_too_large":
            return "URL_FETCH_TOO_LARGE"
        if tag == "arxiv_network":
            return "URL_FETCH_BLOCKED"
        if tag in {"arxiv_http_error", "arxiv_decode_failed"}:
            return "URL_FETCH_BLOCKED"
        if tag in {"arxiv_parse_failed", "arxiv_empty_response"}:
            # Body-level failures: most likely upstream schema change.
            return "VALIDATION_FAILED"
        # Unknown arxiv_* tag — fall through to default.
    return "AI_ENGINE_UNAVAILABLE"


async def _create_run(pool: Any, source: RadarSource, triggered_by: str) -> str:
    run_id = str(uuid.uuid4())
    async with pool.connection() as conn:
        await conn.execute(
            'INSERT INTO "radar_sync_runs" '
            '("id", "sourceId", "triggeredBy", "status", "startedAt", "createdAt") '
            "VALUES (%s, %s, %s, 'running', now(), now())",
            (run_id, source.id, triggered_by),
        )
        await conn.commit()
    return run_id


async def _finish_run(
    pool: Any,
    *,
    run_id: str,
    status: str,
    total_fetched: int,
    total_new: int,
    total_skipped: int,
    total_failed: int,
    token_input_total: int,
    token_output_total: int,
    cost_usd: float,
    elapsed_ms: int,
    error_code: str | None,
    error_message: str | None,
) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "radar_sync_runs" SET "status" = %s, "totalFetched" = %s, '
            '"totalNew" = %s, "totalSkipped" = %s, "totalFailed" = %s, '
            '"tokenInputTotal" = %s, "tokenOutputTotal" = %s, "costUsd" = %s, '
            '"elapsedMs" = %s, "errorCode" = %s, "errorMessage" = %s, '
            '"completedAt" = now(), "lockedBy" = NULL, "leaseExpiresAt" = NULL, '
            '"heartbeatAt" = NULL WHERE "id" = %s',
            (
                status,
                total_fetched,
                total_new,
                total_skipped,
                total_failed,
                token_input_total,
                token_output_total,
                cost_usd,
                elapsed_ms,
                error_code,
                error_message[:500] if error_message else None,
                run_id,
            ),
        )
        await conn.execute(
            'UPDATE "radar_sources" SET "lastSyncAt" = now(), "updatedAt" = now() '
            'WHERE "id" = (SELECT "sourceId" FROM "radar_sync_runs" WHERE "id" = %s)',
            (run_id,),
        )
        await conn.commit()


async def _candidate_exists(pool: Any, canonical_url: str) -> bool:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id" FROM "summaries" WHERE "canonicalUrl" = %s '
                "AND \"status\" <> 'archived' LIMIT 1",
                (canonical_url,),
            )
        ).fetchone()
    return row is not None


async def _insert_candidate(
    pool: Any,
    *,
    candidate: RadarCandidate,
    canonical_url: str,
    fetched: FetchedDocument,
    markdown: str,
    interpretation: str,
    source: RadarSource,
    run_id: str,
    score: Any,
    cost: CostMetrics,
) -> bool:
    title = candidate.title or _infer_title(fetched, markdown)
    body = markdown[:2000] or candidate.snippet or interpretation
    content_sha256 = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    published_at = candidate.published_at
    async with pool.connection() as conn:
        async with conn.transaction():
            row = await (
                await conn.execute(
                    'INSERT INTO "summaries" '
                    '("id", "title", "body", "url", "canonicalUrl", "source", '
                    '"contentOrigin", "summaryDate", "publishedAt", "contentSha256", '
                    '"ingestionTokenCount", "tags", "status", "relevanceScore", '
                    '"timelinessScore", "sourceQualityScore", "scoreVersion", '
                    '"scoreReason", "interpretation", "syncRunId", "createdAt", "updatedAt") '
                    "VALUES (%s, %s, %s, %s, %s, 'daily', %s, %s, %s, %s, %s, %s::text[], "
                    "'candidate', %s, %s, %s, %s, %s, %s, %s, now(), now()) "
                    'ON CONFLICT ("canonicalUrl") DO NOTHING RETURNING "id"',
                    (
                        str(uuid.uuid4()),
                        title[:300],
                        body,
                        candidate.url[:2048],
                        canonical_url,
                        candidate.content_origin,
                        date.today(),
                        published_at,
                        content_sha256,
                        cost.token_input_total + cost.token_output_total,
                        list(candidate.tags),
                        score.relevance,
                        score.timeliness,
                        score.source_quality,
                        score.version,
                        score.reason,
                        interpretation[:2000],
                        run_id,
                    ),
                )
            ).fetchone()
    return row is not None


async def _run_source(
    pool: Any,
    *,
    source: RadarSource,
    triggered_by: str,
    adapter: ResearchEngineAdapter,
    fetchers: dict[str, SourceFetcher] | None,
    document_fetcher: SafeFetcher,
    generate_brief: BriefGenerator,
    generation_timeout_seconds: float,
) -> SourceRunResult:
    run_id = await _create_run(pool, source, triggered_by)
    started = time.monotonic()
    total_fetched = total_new = total_skipped = total_failed = 0
    token_in = token_out = 0
    cost_usd = 0.0
    first_error_code: str | None = None
    try:
        candidates = await fetch_source(source, fetchers=fetchers)
        total_fetched = len(candidates)
        for raw_candidate in candidates:
            try:
                normalized = normalize_candidate(raw_candidate)
                if await _candidate_exists(pool, normalized.canonical_url):
                    total_skipped += 1
                    continue
                fetched = await document_fetcher(raw_candidate.url)
                markdown = html_to_markdown(fetched.content.decode("utf-8", errors="replace"))[:50000]
                item = {
                    "title": normalized.title,
                    "snippet": (markdown or normalized.snippet)[:2000],
                }
                brief = await generate_brief(
                    adapter,
                    item,
                    normalized.canonical_url,
                    timeout_seconds=generation_timeout_seconds,
                )
                token_in += brief.cost.token_input_total
                token_out += brief.cost.token_output_total
                cost_usd += _cost_usd(brief.cost)
                if brief.status != AI_JOB_STATUS["SUCCEEDED"] or not brief.output_text:
                    raise RuntimeError(f"brief generation ended in {brief.status}")
                score = score_candidate(normalized, source_type=source.source_type)
                inserted = await _insert_candidate(
                    pool,
                    candidate=raw_candidate,
                    canonical_url=normalized.canonical_url,
                    fetched=fetched,
                    markdown=markdown,
                    interpretation=brief.output_text.strip(),
                    source=source,
                    run_id=run_id,
                    score=score,
                    cost=brief.cost,
                )
                if inserted:
                    total_new += 1
                else:
                    total_skipped += 1
                logger.info(
                    "ai-engine.radar.candidate_processed",
                    extra={
                        "request_id": run_id,
                        "source_id": source.id,
                        "domain": _host(fetched.url),
                        "status": fetched.status,
                        "bytes_read": len(fetched.content),
                        "elapsed_ms": fetched.elapsed_ms,
                        "redirects": fetched.redirect_count,
                    },
                )
            except Exception as exc:
                total_failed += 1
                first_error_code = first_error_code or _safe_error_code(exc)
                logger.warning(
                    "ai-engine.radar.candidate_failed",
                    extra={
                        "request_id": run_id,
                        "source_id": source.id,
                        "domain": _host(raw_candidate.url),
                        "error_code": _safe_error_code(exc),
                        "error_type": type(exc).__name__,
                    },
                )
        run_status = "partial" if total_failed else "completed"
        error_message = "one or more candidates failed" if total_failed else None
    except Exception as exc:
        total_failed = max(1, total_failed)
        first_error_code = _safe_error_code(exc)
        run_status = "failed"
        error_message = f"source failed: {type(exc).__name__}"
        logger.warning(
            "ai-engine.radar.source_failed",
            extra={
                "request_id": run_id,
                "source_id": source.id,
                "source_type": source.source_type,
                "error_code": first_error_code,
                "error_type": type(exc).__name__,
            },
        )
    elapsed_ms = int((time.monotonic() - started) * 1000)
    await _finish_run(
        pool,
        run_id=run_id,
        status=run_status,
        total_fetched=total_fetched,
        total_new=total_new,
        total_skipped=total_skipped,
        total_failed=total_failed,
        token_input_total=token_in,
        token_output_total=token_out,
        cost_usd=round(cost_usd, 6),
        elapsed_ms=elapsed_ms,
        error_code=first_error_code,
        error_message=error_message,
    )
    return SourceRunResult(
        run_id=run_id,
        source_id=source.id,
        status=run_status,
        total_fetched=total_fetched,
        total_new=total_new,
        total_skipped=total_skipped,
        total_failed=total_failed,
        token_input_total=token_in,
        token_output_total=token_out,
        cost_usd=round(cost_usd, 6),
        error_code=first_error_code,
    )


async def run_radar_sync(
    pool: Any,
    *,
    triggered_by: str = "cron",
    source_ids: set[str] | None = None,
    adapter: ResearchEngineAdapter | None = None,
    fetchers: dict[str, SourceFetcher] | None = None,
    document_fetcher: SafeFetcher = safe_fetch,
    generate_brief: BriefGenerator = _generate_brief,
    generation_timeout_seconds: float = 60.0,
) -> RadarSyncResult:
    """Run all enabled sources independently and return source-level results."""

    if triggered_by not in {"cron", "admin"}:
        raise ValueError("triggered_by must be cron or admin")
    sources = await load_enabled_sources(pool)
    if source_ids is not None:
        sources = [source for source in sources if source.id in source_ids]
    engine = adapter or build_adapter()
    batch_id = str(uuid.uuid4())
    results = await asyncio.gather(
        *(
            _run_source(
                pool,
                source=source,
                triggered_by=triggered_by,
                adapter=engine,
                fetchers=fetchers,
                document_fetcher=document_fetcher,
                generate_brief=generate_brief,
                generation_timeout_seconds=generation_timeout_seconds,
            )
            for source in sources
        )
    )
    return RadarSyncResult(batch_id=batch_id, runs=tuple(results))


async def retry_radar_run(
    pool: Any,
    run_id: str,
    *,
    adapter: ResearchEngineAdapter | None = None,
    fetchers: dict[str, SourceFetcher] | None = None,
    document_fetcher: SafeFetcher = safe_fetch,
    generate_brief: BriefGenerator = _generate_brief,
) -> RadarSyncResult:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "sourceId" FROM "radar_sync_runs" WHERE "id" = %s '
                "AND \"status\" IN ('partial', 'failed')",
                (run_id,),
            )
        ).fetchone()
    if row is None:
        raise LookupError("retryable radar run not found")
    source_id = str(cast(dict[str, Any], row)["sourceId"])
    return await run_radar_sync(
        pool,
        triggered_by="admin",
        source_ids={source_id},
        adapter=adapter,
        fetchers=fetchers,
        document_fetcher=document_fetcher,
        generate_brief=generate_brief,
    )


__all__ = [
    "RadarSyncResult",
    "SourceRunResult",
    "retry_radar_run",
    "run_radar_sync",
]
