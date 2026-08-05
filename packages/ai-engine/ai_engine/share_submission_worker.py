"""Fetch and summarize pending shares; Admin approval creates radar candidates."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, cast
from urllib.parse import urlsplit

from ai_engine.adapters.base import ResearchEngineAdapter, build_adapter
from ai_engine.contracts.states import AI_JOB_STATUS
from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError, safe_fetch
from ai_engine.ingestion.pipeline import _generate_brief, canonicalize_url
from ai_engine.server.share import _infer_title, html_to_markdown

logger = logging.getLogger("ai_engine.share_submission_worker")
SafeFetcher = Callable[..., Awaitable[FetchedDocument]]
BriefGenerator = Callable[..., Awaitable[Any]]


@dataclass(slots=True, frozen=True)
class ShareLease:
    submission_id: str
    worker_id: str
    lease_expires_at: datetime
    heartbeat_interval_seconds: float


@dataclass(slots=True, frozen=True)
class ShareWorkerResult:
    submission_id: str
    summary_id: str | None
    created_candidate: bool
    fetch_error_code: str | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _acquire(pool: Any, worker_id: str) -> tuple[ShareLease, dict[str, Any]] | None:
    lease_seconds = int(os.getenv("WORKER_LEASE_SECONDS", "60"))
    heartbeat_seconds = float(os.getenv("WORKER_HEARTBEAT_SECONDS", "15"))
    now = _now()
    expiry = now + timedelta(seconds=lease_seconds)
    sql = (
        "WITH cte AS ("
        ' SELECT "id" FROM "share_submissions" '
        " WHERE \"status\" = 'pending' AND \"completedAt\" IS NULL "
        ' AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now()) '
        ' AND ("lockedBy" IS NULL OR "leaseExpiresAt" < now()) '
        ' ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1'
        ") UPDATE \"share_submissions\" AS s SET \"lockedBy\" = %s, "
        '"leaseExpiresAt" = %s, "heartbeatAt" = %s, "attempts" = "attempts" + 1 '
        'FROM cte WHERE s."id" = cte."id" '
        'RETURNING s."id", s."submitterId", s."url", s."canonicalUrl", '
        's."userNote", s."attempts"'
    )
    async with pool.connection() as conn:
        async with conn.transaction():
            row = await (await conn.execute(sql, (worker_id, expiry, now))).fetchone()
    if row is None:
        return None
    record = cast(dict[str, Any], row)
    return (
        ShareLease(str(record["id"]), worker_id, expiry, heartbeat_seconds),
        record,
    )


async def _heartbeat(pool: Any, lease: ShareLease) -> bool:
    lease_seconds = int(os.getenv("WORKER_LEASE_SECONDS", "60"))
    now = _now()
    expiry = now + timedelta(seconds=lease_seconds)
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'UPDATE "share_submissions" SET "leaseExpiresAt" = %s, "heartbeatAt" = %s '
                'WHERE "id" = %s AND "lockedBy" = %s AND "status" = \'pending\' '
                'AND "completedAt" IS NULL RETURNING "id"',
                (expiry, now, lease.submission_id, lease.worker_id),
            )
        ).fetchone()
        await conn.commit()
    return row is not None


async def _heartbeat_until_done(pool: Any, lease: ShareLease, done: asyncio.Event) -> None:
    while not done.is_set():
        try:
            await asyncio.wait_for(done.wait(), timeout=max(1.0, lease.heartbeat_interval_seconds))
            return
        except TimeoutError:
            if not await _heartbeat(pool, lease):
                raise RuntimeError("share submission lease lost")


async def _record_fetch_error(pool: Any, lease: ShareLease, exc: SafeFetchError) -> None:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'UPDATE "share_submissions" SET "fetchErrorCode" = %s, '
                '"fetchErrorMessage" = %s, "completedAt" = now(), "lockedBy" = NULL, '
                '"leaseExpiresAt" = NULL, "heartbeatAt" = NULL '
                'WHERE "id" = %s AND "lockedBy" = %s AND "status" = \'pending\' '
                'RETURNING "id"',
                (
                    exc.code,
                    f"fetch failed: {type(exc).__name__}"[:500],
                    lease.submission_id,
                    lease.worker_id,
                ),
            )
        ).fetchone()
        await conn.commit()
    if row is None:
        raise RuntimeError("share submission lease lost while recording fetch failure")


async def _record_retry(pool: Any, lease: ShareLease, exc: BaseException) -> None:
    retryable = isinstance(exc, (asyncio.TimeoutError, TimeoutError, ConnectionError))
    max_retries = int(os.getenv("WORKER_MAX_RETRIES", "3"))
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "attempts" FROM "share_submissions" WHERE "id" = %s '
                'AND "lockedBy" = %s',
                (lease.submission_id, lease.worker_id),
            )
        ).fetchone()
        attempts = int(cast(dict[str, Any], row)["attempts"]) if row is not None else max_retries
        if retryable and attempts < max_retries:
            delay = {1: 30, 2: 120}.get(attempts, 300)
            await conn.execute(
                'UPDATE "share_submissions" SET "nextRetryAt" = now() + (%s * interval \'1 second\'), '
                '"fetchErrorCode" = %s, "fetchErrorMessage" = %s, "lockedBy" = NULL, '
                '"leaseExpiresAt" = NULL, "heartbeatAt" = NULL WHERE "id" = %s AND "lockedBy" = %s',
                (delay, "AI_ENGINE_UNAVAILABLE", type(exc).__name__, lease.submission_id, lease.worker_id),
            )
        else:
            await conn.execute(
                'UPDATE "share_submissions" SET "fetchErrorCode" = %s, "fetchErrorMessage" = %s, '
                '"completedAt" = now(), "lockedBy" = NULL, "leaseExpiresAt" = NULL, '
                '"heartbeatAt" = NULL WHERE "id" = %s AND "lockedBy" = %s',
                (
                    "WORKER_RETRY_EXHAUSTED" if retryable else "INTERNAL",
                    type(exc).__name__,
                    lease.submission_id,
                    lease.worker_id,
                ),
            )
        await conn.commit()


async def _persist_success(
    pool: Any,
    *,
    lease: ShareLease,
    record: dict[str, Any],
    fetched: FetchedDocument,
    markdown: str,
    title: str,
    interpretation: str,
) -> tuple[str | None, bool]:
    canonical = canonicalize_url(str(record["url"])) or canonicalize_url(str(record["canonicalUrl"]))
    if not canonical:
        raise ValueError("share submission canonical URL is invalid")
    content_sha = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    async with pool.connection() as conn:
        async with conn.transaction():
            updated = await (
                await conn.execute(
                    'UPDATE "share_submissions" SET "canonicalUrl" = %s, "fetchedTitle" = %s, '
                    '"fetchedMarkdown" = %s, "summaryText" = %s, "contentSha256" = %s, '
                    '"bytesRead" = %s, "elapsedMs" = %s, "completedAt" = now(), '
                    '"fetchErrorCode" = NULL, "fetchErrorMessage" = NULL, "lockedBy" = NULL, '
                    '"leaseExpiresAt" = NULL, "heartbeatAt" = NULL WHERE "id" = %s '
                    'AND "lockedBy" = %s AND "status" = \'pending\' RETURNING "id"',
                    (
                        canonical[:2048],
                        title[:300],
                        markdown[:50000],
                        interpretation[:2000],
                        content_sha,
                        len(fetched.content),
                        fetched.elapsed_ms,
                        lease.submission_id,
                        lease.worker_id,
                    ),
                )
            ).fetchone()
            if updated is None:
                raise RuntimeError("share submission lease lost before commit")
    # The worker deliberately does not insert into summaries. Unreviewed user
    # content must not become a public radar candidate before Admin approval.
    return None, False


async def run_one_share_submission(
    pool: Any,
    adapter: ResearchEngineAdapter,
    *,
    worker_id: str,
    fetcher: SafeFetcher = safe_fetch,
    generate_brief: BriefGenerator = _generate_brief,
    generation_timeout_seconds: float = 60.0,
) -> ShareWorkerResult | None:
    acquired = await _acquire(pool, worker_id)
    if acquired is None:
        return None
    lease, record = acquired
    done = asyncio.Event()
    heartbeat_task = asyncio.create_task(_heartbeat_until_done(pool, lease, done))
    try:
        fetched = await fetcher(str(record["url"]))
        markdown = html_to_markdown(fetched.content.decode("utf-8", errors="replace"))[:50000]
        title = _infer_title(fetched, markdown)
        canonical = canonicalize_url(str(record["url"]))
        brief = await generate_brief(
            adapter,
            {"title": title, "snippet": markdown[:2000]},
            canonical,
            timeout_seconds=generation_timeout_seconds,
        )
        if heartbeat_task.done():
            await heartbeat_task
        if brief.status != AI_JOB_STATUS["SUCCEEDED"] or not brief.output_text:
            raise RuntimeError(f"brief generation ended in {brief.status}")
        summary_id, created = await _persist_success(
            pool,
            lease=lease,
            record=record,
            fetched=fetched,
            markdown=markdown,
            title=title,
            interpretation=brief.output_text.strip(),
        )
        logger.info(
            "ai-engine.share_submission.completed",
            extra={
                "request_id": lease.submission_id,
                "submission_id": lease.submission_id,
                "domain": (urlsplit(fetched.url).hostname or "").lower(),
                "status": fetched.status,
                "bytes_read": len(fetched.content),
                "elapsed_ms": fetched.elapsed_ms,
                "redirects": fetched.redirect_count,
            },
        )
        return ShareWorkerResult(lease.submission_id, summary_id, created)
    except SafeFetchError as exc:
        await _record_fetch_error(pool, lease, exc)
        logger.warning(
            "ai-engine.share_submission.fetch_failed",
            extra={
                "request_id": lease.submission_id,
                "submission_id": lease.submission_id,
                "domain": exc.host or "",
                "error_code": exc.code,
                "error_type": type(exc).__name__,
            },
        )
        return ShareWorkerResult(lease.submission_id, None, False, exc.code)
    except Exception as exc:
        await _record_retry(pool, lease, exc)
        logger.warning(
            "ai-engine.share_submission.failed",
            extra={
                "request_id": lease.submission_id,
                "submission_id": lease.submission_id,
                "error_code": "AI_ENGINE_UNAVAILABLE",
                "error_type": type(exc).__name__,
            },
        )
        return ShareWorkerResult(lease.submission_id, None, False, "AI_ENGINE_UNAVAILABLE")
    finally:
        done.set()
        heartbeat_task.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat_task


async def run_share_submission_worker_once() -> ShareWorkerResult | None:
    from ai_engine.job_runner.db_store import DbJobStore

    store = DbJobStore()
    async with store:
        return await run_one_share_submission(
            store.pool,
            build_adapter(),
            worker_id=f"share-{os.getpid()}",
        )


__all__ = [
    "ShareLease",
    "ShareWorkerResult",
    "run_one_share_submission",
    "run_share_submission_worker_once",
]
