"""Technical radar synchronization runner.

Each enabled source owns one ``radar_sync_runs`` row. Source and candidate
failures are isolated, and the source run records counts/cost without ever
publishing candidates automatically.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re as _re
import socket
import time
import uuid
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, cast
from urllib.parse import urlsplit

from ai_engine.adapters.base import CostMetrics, ResearchEngineAdapter, build_adapter
from ai_engine.contracts.errors import ERROR_CODES
from ai_engine.contracts.states import AI_JOB_STATUS
from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError, safe_fetch
from ai_engine.ingestion.pipeline import _generate_brief
from ai_engine.markdown_pipeline import normalize_markdown
from ai_engine.radar.models import RadarCandidate, RadarSource
from ai_engine.radar.candidate_filter import filter_candidate
from ai_engine.radar.pipeline import normalize_candidate, score_candidate
from ai_engine.radar.source_manager import SourceFetcher, fetch_source, load_enabled_sources
from ai_engine.server.share import _infer_title, html_to_markdown

logger = logging.getLogger("ai_engine.radar.sync_runner")
BriefGenerator = Callable[..., Awaitable[Any]]
SafeFetcher = Callable[..., Awaitable[FetchedDocument]]
DistilledScorerFn = Callable[..., Awaitable[Any]]
EmbeddingScorerFn = Any  # BatchEmbeddingScorer or None

# Preserve long-form papers and articles. Prompt construction applies its own
# token budget later; truncating the stored source here destroys the reader's
# ability to inspect the complete document.
ORIGINAL_MARKDOWN_MAX_BYTES = 256 * 1024
MIN_BRIEF_OUTPUT_CHARS = 120
MIN_LIMITED_SCORE_CONTENT_CHARS = 300
MIN_FULL_SCORE_CONTENT_CHARS = 1_000

# Feature flag: when false, sync behaves as Week 9 (no capture, no UI).
DEEPDIVE_ENABLED = os.environ.get("RADAR_DEEPDIVE_ENABLED", "true").lower() in (
    "1", "true", "yes", "on",
)

# Bound concurrent source runs. Candidate-level concurrency and the shared
# LLM semaphore apply additional limits inside each source.
RADAR_SOURCE_CONCURRENCY = int(os.environ.get("RADAR_SOURCE_CONCURRENCY", "5"))
RADAR_CANDIDATE_CONCURRENCY = int(
    os.environ.get("RADAR_CANDIDATE_CONCURRENCY", "3")
)
RADAR_FETCH_RETRIES = max(0, int(os.environ.get("RADAR_FETCH_RETRIES", "2")))
RADAR_FETCH_RETRY_BACKOFF_SECONDS = max(
    0.0, float(os.environ.get("RADAR_FETCH_RETRY_BACKOFF_SECONDS", "0.5"))
)
# A successful HTTP response can still be an empty page or bot-verification
# shell. Give that content one bounded retry before routing it to governance.
RADAR_CONTENT_RETRIES = max(0, int(os.environ.get("RADAR_CONTENT_RETRIES", "1")))
RADAR_CONTENT_RETRY_BACKOFF_SECONDS = max(
    0.0, float(os.environ.get("RADAR_CONTENT_RETRY_BACKOFF_SECONDS", "1.0"))
)
RADAR_SOURCE_RETRIES = max(0, int(os.environ.get("RADAR_SOURCE_RETRIES", "2")))
RADAR_SOURCE_RETRY_BACKOFF_SECONDS = max(
    0.0, float(os.environ.get("RADAR_SOURCE_RETRY_BACKOFF_SECONDS", "10"))
)
RADAR_RATE_LIMIT_RETRY_BACKOFF_SECONDS = max(
    0.0, float(os.environ.get("RADAR_RATE_LIMIT_RETRY_BACKOFF_SECONDS", "60"))
)
RADAR_ENRICHMENT_RETRIES = max(
    0, int(os.environ.get("RADAR_ENRICHMENT_RETRIES", "2"))
)
RADAR_RUN_LEASE_SECONDS = max(
    60, int(os.environ.get("RADAR_RUN_LEASE_SECONDS", "900"))
)
# Brief generation retry policy mirrors agents-radar/src/report.ts:
# HTTP 429 gets up to 3 retries with 5s/10s/20s backoff.
_BRIEF_RATE_LIMIT_RETRIES = 3
_BRIEF_RATE_LIMIT_BACKOFF = (5.0, 10.0, 20.0)

# Pages that are too short, or bot-verification shells, are not useful
# LLM brief material. Product Hunt is the common case: safe_fetch often
# lands on a Cloudflare "Just a moment..." page.
_LOW_QUALITY_MARKERS = (
    "just a moment",
    "enable javascript and cookies",
    "challenge-platform",
    "verify you are human",
    "checking your browser",
    "attention required! | cloudflare",
    "performance & security by cloudflare",
    "cf-chl-",
    "access denied",
)

_CONTENT_FETCH_FAILURE_CODE = "CONTENT_FETCH_FAILED"

# These sources provide a meaningful title/snippet in their API response.
# A blocked detail page must not turn an otherwise usable signal into a hard
# candidate failure.
_SNIPPET_FALLBACK_SOURCE_TYPES = {
    "github", "github_trending",
    "hackernews", "producthunt", "reddit", "lobsters", "devto",
    "huggingface_models", "vendor_news", "rss",
}


def _classify_original_kind(source_type: str, url: str) -> str:
    """Map (source_type, url) to a deep-dive renderer discriminator.

    Why a free-form string and not a Prisma enum: the radar daily currently
    captures ``content_origin`` (web|rss|api|manual) but we cannot tell an
    arxiv abstract from a Hacker News link from a GitHub README from those
    four values. The deep-dive renderer paths diverge widely per source type
    (zread.ai-style for repos, Lumi-style for arxiv, plain markdown for
    prose blogs) so we need a richer discriminator.
    """
    u = (url or "").lower()
    if "arxiv.org/abs/" in u or "huggingface.co/papers/" in u or source_type in ("arxiv", "huggingface_papers"):
        return "arxiv"
    if source_type in ("github", "github_trending") or "github.com" in u:
        if "/releases/tag/" in u:
            return "github_release"
        # repo root: github.com/{owner}/{repo} (optionally trailing slash)
        # Tracked-repo digests append ?digest=YYYY-MM-DD; strip the query so
        # the deep-dive renderer still treats them as repo pages.
        if _GITHUB_REPO_RE.match(u.split("?", 1)[0]):
            return "github_repo"
        return "github_other"
    if source_type == "rss" or source_type == "devto":
        return "rss"
    return "web_share"


def _arxiv_id_from_url(url: str) -> str | None:
    """Extract a modern arXiv identifier from arXiv or HF Daily Papers URLs."""
    import re as _re

    match = _re.search(
        r"(?:arxiv\.org/(?:abs|html)/|huggingface\.co/papers/)([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)",
        (url or "").lower(),
    )
    return match.group(1) if match else None


def _preferred_document_urls(url: str, source_type: str) -> list[str]:
    """Prefer rendered arXiv HTML while retaining a safe source fallback."""
    arxiv_id = _arxiv_id_from_url(url)
    if not arxiv_id and source_type not in ("arxiv", "huggingface_papers"):
        return [url]
    candidates = [
        f"https://arxiv.org/html/{arxiv_id}" if arxiv_id else "",
        f"https://ar5iv.labs.arxiv.org/html/{arxiv_id}" if arxiv_id else "",
        f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else "",
        url,
    ]
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))


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
    fallback_count: int = 0
    skipped_existing: int = 0
    skipped_rule_noise: int = 0
    skipped_distilled_noise: int = 0
    skipped_conflict: int = 0


@dataclass(slots=True, frozen=True)
class RadarSyncResult:
    batch_id: str
    runs: tuple[SourceRunResult, ...]


@dataclass(slots=True, frozen=True)
class RadarPipelineResult:
    """One complete radar task: sync, scoring and enrichment."""

    sync: RadarSyncResult
    enriched_count: int
    enrichment_elapsed_ms: int
    enrichment_error: str | None = None


def _host(value: str) -> str:
    return (urlsplit(value).hostname or "").lower()


_GITHUB_REPO_RE = _re.compile(r"https?://(?:www\.)?github\.com/[^/]+/[^/]+/?$")


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
      ``URL_FETCH_NETWORK`` (connect, TLS, protocol; security policy
      rejections are surfaced by ``SafeFetchError`` as BLOCKED)
    - ``RuntimeError`` raised by ``ingestion.sources.fetch_arxiv`` (prefix
      ``arxiv_*``) → specific codes so dashboards can split transport
      failures from rate-limit hits and parse errors
    - anything else → ``AI_ENGINE_UNAVAILABLE`` (genuine unknown)
    """
    if isinstance(exc, SafeFetchError):
        return exc.code
    explicit_code = getattr(exc, "error_code", None)
    if isinstance(explicit_code, str) and explicit_code in ERROR_CODES:
        return explicit_code
    if isinstance(exc, socket.gaierror):
        return "URL_FETCH_DNS"
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "WORKER_TIMEOUT"
    if isinstance(exc, ValueError):
        return "VALIDATION_FAILED"
    # A database outage is an infrastructure failure, not an LLM outage.
    # Keep it distinct so the scheduler can stop retry amplification and the
    # admin surface can point at the actual dependency.
    try:
        import psycopg
        if isinstance(exc, psycopg.OperationalError):
            return "DATABASE_UNAVAILABLE"
    except ImportError:
        pass
    # httpx errors surface from safe_fetch wrappers + the arxiv fetcher.
    # We import lazily to avoid pulling httpx into sync_runner tests.
    import httpx as _httpx

    if isinstance(exc, _httpx.HTTPStatusError):
        response = exc.response
        remaining = response.headers.get("x-ratelimit-remaining", "").strip()
        if response.status_code == 429 or (
            response.status_code == 403 and remaining == "0"
        ):
            return "UPSTREAM_RATE_LIMITED"
    if isinstance(exc, _httpx.TimeoutException):
        return "URL_FETCH_TIMEOUT"
    if isinstance(exc, (_httpx.ConnectError, _httpx.ConnectTimeout,
                        _httpx.NetworkError, _httpx.RemoteProtocolError)):
        return "URL_FETCH_NETWORK"
    if isinstance(exc, _httpx.HTTPError):
        return "URL_FETCH_NETWORK"
    # fetch_arxiv classifies its own failures with leading ``arxiv_*`` tags.
    msg = str(exc) or ""
    if msg.startswith("arxiv_"):
        tag = msg.split(":", 1)[0]
        # Translate the arxiv-specific tags to the public contract codes
        # so dashboards / alerts can group by HTTP-style semantics.
        if tag == "arxiv_timeout":
            return "WORKER_TIMEOUT"
        if tag == "arxiv_rate_limited":
            return "UPSTREAM_RATE_LIMITED"
        if tag == "arxiv_too_large":
            return "URL_FETCH_TOO_LARGE"
        if tag == "arxiv_network":
            return "URL_FETCH_NETWORK"
        if tag in {"arxiv_http_error", "arxiv_decode_failed"}:
            return "URL_FETCH_NETWORK"
        if tag in {"arxiv_parse_failed", "arxiv_empty_response"}:
            # Body-level failures: most likely upstream schema change.
            return "VALIDATION_FAILED"
        # Unknown arxiv_* tag — fall through to default.
    return "AI_ENGINE_UNAVAILABLE"


class _BriefGenerationError(RuntimeError):
    """Preserve the adapter's public error code through candidate handling."""

    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code


def _error_domain(exc: BaseException, fallback: str = "") -> str:
    """Return a query-free host for persisted failure diagnostics."""
    if isinstance(exc, SafeFetchError) and exc.host:
        return exc.host.lower()
    try:
        request = getattr(exc, "request", None)
    except RuntimeError:
        # httpx exposes ``request`` as a property that raises when a synthetic
        # transport exception was created without attaching a request.
        request = None
    request_url = getattr(request, "url", None)
    request_host = getattr(request_url, "host", None)
    if request_host:
        return str(request_host).lower()
    return fallback.lower()


def _source_domain(source: RadarSource) -> str:
    for key in ("feedUrl", "url", "sitemapUrl", "sitemap_url"):
        value = str(source.config.get(key) or "").strip()
        if value:
            return _host(value)
    return ""


def _is_retryable_transport_error(exc: BaseException) -> bool:
    if isinstance(exc, SafeFetchError):
        return exc.code in {"URL_FETCH_DNS", "URL_FETCH_TIMEOUT"}
    if isinstance(exc, socket.gaierror):
        return True
    import httpx as _httpx

    if isinstance(exc, (_httpx.TimeoutException, _httpx.ConnectError,
                        _httpx.NetworkError, _httpx.RemoteProtocolError)):
        return True
    # Some source adapters deliberately wrap their HTTP exception to keep a
    # stable source-specific prefix. Retry only when that wrapper still
    # contains an unambiguous transient transport/rate-limit marker.
    message = str(exc).lower()
    return any(marker in message for marker in (
        "connecttimeout", "readtimeout", "connecterror", "networkerror",
        "timed out", "timeout", "rate limit", "status code 429", " 429 ",
    ))


def _is_retryable_source_result(result: SourceRunResult) -> bool:
    """Return whether a failed/partial source is likely to recover on retry."""
    if result.status not in {"partial", "failed"}:
        return False
    # Explicit upstream blocks are policy decisions, not transient failures.
    return result.error_code not in {
        "URL_FETCH_BLOCKED",
        "CONTENT_TYPE_REJECTED",
        "UPSTREAM_AUTH_REQUIRED",
        "WEWE_AUTH_CONFIG_INVALID",
        "DATABASE_UNAVAILABLE",
    }


def _retryable_latest_source_ids(
    results: list[SourceRunResult],
) -> set[str]:
    """Return retryable sources based only on each source's latest run."""
    latest: dict[str, SourceRunResult] = {}
    for result in results:
        latest[result.source_id] = result
    return {
        source_id
        for source_id, result in latest.items()
        if _is_retryable_source_result(result)
    }


def _can_use_snippet_fallback(source: RadarSource, candidate: RadarCandidate) -> bool:
    return (
        source.source_type in _SNIPPET_FALLBACK_SOURCE_TYPES
        and len(candidate.snippet.strip()) >= 200
    )


def _can_use_candidate_metadata_fallback(
    source: RadarSource,
    candidate: RadarCandidate,
) -> bool:
    """Keep a source candidate when its detail page is incomplete.

    A source adapter's title/snippet is still useful evidence for a later
    retry. It must not be passed to the final relevance scorer as if it were
    the full article, but it should remain visible as a pending candidate.
    Verification shells and empty snippets stay in governance instead.
    """
    del source  # reserved for source-specific policies as adapters evolve
    snippet = candidate.snippet.strip()
    if len(snippet) < 20:
        return False
    lowered = snippet.lower()
    return not any(
        marker in lowered
        for marker in (
            *_LOW_QUALITY_MARKERS,
            "prove your humanity",
            "complete the challenge",
            "all rights reserved",
        )
    )


def _can_use_github_repo_metadata_fallback(
    source: RadarSource,
    candidate: RadarCandidate,
) -> bool:
    """Keep GitHub repo candidates when the detail page is blocked.

    GitHub Trending already gives us a meaningful repository description,
    stars and language. A failed fetch of github.com should not discard that
    source-level signal; it should enter the candidate queue with the
    metadata clearly treated as a fallback context.
    """
    return (
        source.source_type in {"github", "github_trending"}
        and _classify_original_kind(source.source_type, candidate.url) == "github_repo"
        and _can_use_candidate_metadata_fallback(source, candidate)
    )


def _is_github_repo_candidate(
    source: RadarSource,
    candidate: RadarCandidate,
) -> bool:
    """Return whether a candidate is a repository root, not an issue/release.

    Curated repositories must receive one Distilled decision even when the
    GitHub HTML page is unavailable.  The API description and structured repo
    signals are still valid triage evidence; issue/PR/release pages are not.
    """
    return (
        source.source_type in {"github", "github_trending"}
        and _classify_original_kind(source.source_type, candidate.url) == "github_repo"
    )


def _best_content_body(
    interpretation: str,
    markdown: str,
    snippet: str,
) -> str:
    """Choose a reviewable body without hiding fetched content behind a terse brief."""
    brief = interpretation.strip()
    raw = markdown.strip()
    source_snippet = snippet.strip()
    if len(brief) >= MIN_BRIEF_OUTPUT_CHARS:
        return brief[:2000]
    if len(raw) >= 200:
        return raw[:2000]
    return (brief or raw or source_snippet)[:2000]


def _strip_reasoning_markup(value: str) -> str:
    """Remove provider reasoning markup before persisting a radar brief."""
    cleaned = str(value or "").strip()
    cleaned = _re.sub(
        r"<think[^>]*>.*?</think[^>]*>",
        "",
        cleaned,
        flags=_re.IGNORECASE | _re.DOTALL,
    )
    return _re.sub(
        r"<think[^>]*>[\s\S]*$",
        "",
        cleaned,
        flags=_re.IGNORECASE,
    ).strip()


async def _with_transport_retries(
    operation: Callable[[], Awaitable[Any]],
    *,
    run_id: str,
    source_id: str,
    domain: str,
) -> Any:
    """Retry transient source/page transport failures with bounded backoff."""
    for attempt in range(RADAR_FETCH_RETRIES + 1):
        try:
            return await operation()
        except Exception as exc:
            if attempt >= RADAR_FETCH_RETRIES or not _is_retryable_transport_error(exc):
                raise
            wait_seconds = RADAR_FETCH_RETRY_BACKOFF_SECONDS * (2 ** attempt)
            logger.warning(
                "ai-engine.radar.transport_retry",
                extra={
                    "request_id": run_id,
                    "source_id": source_id,
                    "domain": _error_domain(exc, domain),
                    "error_code": _safe_error_code(exc),
                    "error_type": type(exc).__name__,
                    "attempt": attempt + 1,
                    "wait_seconds": wait_seconds,
                },
            )
            if wait_seconds:
                await asyncio.sleep(wait_seconds)


async def _fetch_document_with_content_retries(
    document_fetcher: SafeFetcher,
    *,
    url: str,
    source_type: str,
    run_id: str,
    source_id: str,
    domain: str,
) -> tuple[FetchedDocument, str]:
    """Fetch and extract a page, retrying successful-but-empty responses once."""
    last_error: Exception | None = None
    for document_url in _preferred_document_urls(url, source_type):
        for attempt in range(RADAR_CONTENT_RETRIES + 1):
            try:
                fetched = await _with_transport_retries(
                    lambda: document_fetcher(document_url),
                    run_id=run_id,
                    source_id=source_id,
                    domain=domain,
                )
            except Exception as exc:
                last_error = exc
                # A rendered arXiv mirror can be unavailable for a new or
                # malformed paper; continue to arXiv HTML/abstract/original.
                break
            raw_html = fetched.content.decode("utf-8", errors="replace")
            markdown = _extract_article_content(raw_html, document_url, source_type)
            if not _is_low_quality_content(markdown) or attempt >= RADAR_CONTENT_RETRIES:
                return fetched, markdown
            wait_seconds = RADAR_CONTENT_RETRY_BACKOFF_SECONDS * (attempt + 1)
            logger.warning(
                "ai-engine.radar.content_retry",
                extra={
                    "request_id": run_id,
                    "source_id": source_id,
                    "domain": domain,
                    "attempt": attempt + 1,
                    "wait_seconds": wait_seconds,
                    "status": fetched.status,
                    "content_length": len(markdown),
                },
            )
            if wait_seconds:
                await asyncio.sleep(wait_seconds)
        if last_error is None:
            continue
    if last_error is not None:
        raise last_error
    raise RuntimeError("content retry loop exhausted")


def _format_failure_summary(
    failures: Counter[tuple[str, str, str]],
    *,
    prefix: str,
) -> str:
    """Build a compact aggregate suitable for ``radar_sync_runs.errorMessage``."""
    parts: list[str] = []
    for (error_code, error_type, domain), count in failures.most_common():
        location = f"@{domain}" if domain else ""
        parts.append(f"{error_type}/{error_code}{location} x{count}")
    return f"{prefix}: " + "; ".join(parts)


async def _create_run(pool: Any, source: RadarSource, triggered_by: str) -> str:
    run_id = str(uuid.uuid4())
    async with pool.connection() as conn:
        await conn.execute(
            'INSERT INTO "radar_sync_runs" '
            '("id", "sourceId", "triggeredBy", "status", "startedAt", "createdAt", '
            '"lockedBy", "heartbeatAt", "leaseExpiresAt") '
            "VALUES (%s, %s, %s, 'running', now(), now(), %s, now(), "
            "now() + (%s || ' seconds')::interval)",
            (
                run_id,
                source.id,
                triggered_by,
                f"radar:{run_id}",
                RADAR_RUN_LEASE_SECONDS,
            ),
        )
        await conn.commit()
    return run_id


async def _heartbeat_run(pool: Any, run_id: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "radar_sync_runs" SET "heartbeatAt" = now(), '
            '"leaseExpiresAt" = now() + (%s || \' seconds\')::interval '
            'WHERE "id" = %s AND "status" = \'running\'',
            (RADAR_RUN_LEASE_SECONDS, run_id),
        )
        await conn.commit()


async def _finish_run(
    pool: Any,
    *,
    run_id: str,
    status: str,
    total_fetched: int,
    total_new: int,
    total_skipped: int,
    total_failed: int,
    fallback_count: int,
    skipped_existing: int,
    skipped_rule_noise: int,
    skipped_distilled_noise: int,
    skipped_conflict: int,
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
            '"fallbackCount" = %s, "skippedExisting" = %s, '
            '"skippedRuleNoise" = %s, "skippedDistilledNoise" = %s, '
            '"skippedConflict" = %s, '
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
                fallback_count,
                skipped_existing,
                skipped_rule_noise,
                skipped_distilled_noise,
                skipped_conflict,
                run_id,
            ),
        )
        await conn.execute(
            'UPDATE "radar_sources" SET "lastSyncAt" = now(), "updatedAt" = now() '
            'WHERE "id" = (SELECT "sourceId" FROM "radar_sync_runs" WHERE "id" = %s)',
            (run_id,),
        )
        # PR1 radar-source-health: surface per-source failure state.
        # A "completed" run resets the streak; any "failed" or "partial" run
        # carrying an error_code bumps consecutive_failures + records the
        # most recent failure for the admin dashboard.
        if status == "completed":
            await conn.execute(
                'UPDATE "radar_sources" SET '
                '"consecutiveFailures" = 0, '
                '"lastErrorCode" = NULL, '
                '"lastErrorMessage" = NULL, '
                '"lastErrorAt" = NULL, '
                '"updatedAt" = now() '
                'WHERE "id" = (SELECT "sourceId" FROM "radar_sync_runs" WHERE "id" = %s)',
                (run_id,),
            )
        elif error_code:
            await conn.execute(
                'UPDATE "radar_sources" SET '
                '"consecutiveFailures" = "consecutiveFailures" + 1, '
                '"lastErrorCode" = %s, '
                '"lastErrorMessage" = %s, '
                '"lastErrorAt" = now(), '
                '"updatedAt" = now() '
                'WHERE "id" = (SELECT "sourceId" FROM "radar_sync_runs" WHERE "id" = %s)',
                (
                    error_code,
                    error_message[:500] if error_message else None,
                    run_id,
                ),
            )
        await conn.commit()


async def _existing_candidate(pool: Any, canonical_url: str) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id", "body", "originalMarkdown", "tags" FROM "summaries" '
                'WHERE "canonicalUrl" = %s '
                "AND \"status\" <> 'archived' LIMIT 1",
                (canonical_url,),
            )
        ).fetchone()
    return dict(row) if row else None


def _needs_content_retry(row: dict[str, Any]) -> bool:
    content = str(row.get("originalMarkdown") or row.get("body") or "")
    return _is_low_quality_content(content)


async def _retry_existing_summary_content(
    pool: Any,
    *,
    summary_id: str,
    candidate: RadarCandidate,
    canonical_url: str,
    source: RadarSource,
    run_id: str,
    document_fetcher: SafeFetcher,
    generate_brief: BriefGenerator,
    adapter: ResearchEngineAdapter,
    timeout_seconds: float,
) -> bool:
    """Replace a bot-check placeholder when a later fetch gets real content."""
    try:
        fetched, markdown = await _fetch_document_with_content_retries(
            document_fetcher,
            url=candidate.url,
            source_type=source.source_type,
            run_id=run_id,
            source_id=source.id,
            domain=_host(candidate.url),
        )
    except Exception:
        return False
    if _is_low_quality_content(markdown):
        return False
    interpretation = ""
    try:
        brief = await _generate_brief_with_retry(
            generate_brief,
            adapter,
            {"title": candidate.title, "snippet": markdown[:2000]},
            canonical_url,
            timeout_seconds=timeout_seconds,
        )
        if brief.status == AI_JOB_STATUS["SUCCEEDED"] and brief.output_text:
            interpretation = _strip_reasoning_markup(brief.output_text)[:2000]
    except Exception:
        pass
    body = _best_content_body(interpretation, markdown, candidate.snippet)
    content_sha256 = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "summaries" SET "title" = %s, "body" = %s, '
            '"interpretation" = %s, "originalMarkdown" = %s, '
            '"originalFetchedAt" = now(), "originalBytes" = %s, '
            '"originalSha256" = %s, "summaryDate" = CURRENT_DATE, '
            '"publishedAt" = %s, "syncRunId" = %s, '
            '"tags" = array_remove(array_remove("tags", \'github_content_pending\'), \'content_pending\'), '
            '"updatedAt" = now() '
            'WHERE "id" = %s',
            (
                candidate.title[:300], body, interpretation or None,
                markdown[:ORIGINAL_MARKDOWN_MAX_BYTES],
                len(markdown.encode("utf-8")), content_sha256,
                candidate.published_at or datetime.now(timezone.utc),
                run_id, summary_id,
            ),
        )
        await conn.commit()
    return True


async def _record_sync_diagnostic(
    pool: Any,
    *,
    source: RadarSource,
    run_id: str,
    candidate: RadarCandidate,
    canonical_url: str,
    kind: str,
    reason_code: str,
    reason_message: str | None = None,
    error_type: str | None = None,
    error_domain: str | None = None,
    distilled: Any | None = None,
    body: str | None = None,
    markdown: str | None = None,
) -> None:
    """Persist a reviewable record for candidates that never become summaries."""
    original_markdown = None
    original_kind = None
    if markdown and DEEPDIVE_ENABLED:
        original_kind = _classify_original_kind(source.source_type, candidate.url)
        original_markdown = markdown.encode("utf-8")[:ORIGINAL_MARKDOWN_MAX_BYTES].decode(
            "utf-8", errors="replace"
        )
    distilled_payload = None
    distilled_tier = None
    if distilled is not None and not getattr(distilled, "is_default", False):
        distilled_payload = json.dumps(distilled.to_dict(), ensure_ascii=False)
        distilled_tier = getattr(distilled, "tier", None)
    try:
        async with pool.connection() as conn:
            await conn.execute(
                'INSERT INTO "radar_sync_diagnostics" '
                '("id", "runId", "sourceId", "kind", "title", "url", '
                '"canonicalUrl", "body", "originalMarkdown", "originalKind", '
                '"contentOrigin", "publishedAt", "tags", "reasonCode", '
                '"reasonMessage", "errorType", "errorDomain", "distilledScore", '
                '"distilledTier", "createdAt", "updatedAt") '
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
                "%s::text[], %s, %s, %s, %s, %s::jsonb, %s, now(), now())",
                (
                    str(uuid.uuid4()),
                    run_id,
                    source.id,
                    kind,
                    (candidate.title or "Untitled")[:300],
                    candidate.url[:2048],
                    canonical_url[:2048],
                    (body or candidate.snippet or "")[:64_000],
                    original_markdown,
                    original_kind,
                    candidate.content_origin,
                    candidate.published_at,
                    list(candidate.tags),
                    reason_code,
                    (reason_message or "")[:500] or None,
                    error_type,
                    error_domain,
                    distilled_payload,
                    distilled_tier,
                ),
            )
            await conn.commit()
    except Exception:
        # Diagnostics must never turn a source-level skip into a source failure.
        logger.warning(
            "ai-engine.radar.diagnostic_write_failed",
            extra={"request_id": run_id, "source_id": source.id, "kind": kind},
        )


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
    extra_tags: tuple[str, ...] = (),
    distilled: Any | None = None,
    limited_score: bool = False,
) -> bool:
    candidate_title = (candidate.title or "").strip()
    # RSS feeds occasionally provide a missing-title placeholder. Treat it as
    # missing so the fetched page title can be recovered from HTML/Markdown.
    if candidate_title.casefold() in {"untitled", "(no title)", "no title"}:
        candidate_title = ""
    title = candidate_title or _infer_title(fetched, markdown)

    merged_tags = list(candidate.tags) + list(extra_tags)
    if _is_fetch_failure_shell(markdown):
        merged_tags.append("fetch_failed_shell")
    persisted_distilled = (
        distilled if distilled is not None and not distilled.is_default else None
    )
    if persisted_distilled is not None:
        if persisted_distilled.must_read:
            merged_tags.append("must_read")
        if persisted_distilled.tier:
            merged_tags.append(f"tier_{persisted_distilled.tier}")
        if persisted_distilled.veto:
            merged_tags.append(f"veto_{persisted_distilled.veto}")
        if persisted_distilled.risk_flag:
            merged_tags.append(f"risk_{persisted_distilled.risk_flag}")
        if persisted_distilled.suspected_repost:
            merged_tags.append("risk_suspected_repost")
        merged_tags.append(f"profile_{persisted_distilled.profile_id}")
    # Prefer a substantive AI brief, but never hide a fetched article behind a
    # terse one-line model response. The full capture remains available in
    # originalMarkdown for deep-dive rendering.
    body = _best_content_body(interpretation, markdown, candidate.snippet)
    content_sha256 = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    published_at = candidate.published_at

    # Phase 0 deep-dive: persist original markdown + classifier metadata.
    # 64KB cap keeps the Postgres row under TOAST threshold and the chat
    # seed snapshot (50KB cap) safely bounded. Skipped entirely when the
    # feature flag is off (Week 9 parity).
    original_markdown: str | None = None
    original_kind: str | None = None
    original_bytes: int | None = None
    if DEEPDIVE_ENABLED:
        original_kind = _classify_original_kind(source.source_type, candidate.url)
        truncated = markdown.encode("utf-8")[:ORIGINAL_MARKDOWN_MAX_BYTES]
        original_markdown = truncated.decode("utf-8", errors="replace")
        original_bytes = len(truncated)

    async with pool.connection() as conn:
        async with conn.transaction():
            row = await (
                await conn.execute(
                    'INSERT INTO "summaries" '
                    '("id", "title", "body", "url", "canonicalUrl", "source", '
                    '"contentOrigin", "summaryDate", "publishedAt", "contentSha256", '
                    '"ingestionTokenCount", "tags", "status", "relevanceScore", '
                    '"timelinessScore", "sourceQualityScore", "scoreVersion", '
                    '"scoreReason", "distilledScore", "distilledTotal", "distilledTier", '
                    '"distilledMustRead", "distilledProfile", "interpretation", "syncRunId", '
                    '"originalMarkdown", "originalKind", "originalFetchedAt", '
                    '"originalBytes", "originalSha256", '
                    '"createdAt", "updatedAt") '
                    "VALUES (%s, %s, %s, %s, %s, 'daily', %s, %s, %s, %s, %s, %s::text[], "
                    "'candidate', %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, "
                    "%s, %s, now(), %s, %s, "
                    "now(), now()) "
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
                        merged_tags,
                        score.relevance,
                        score.timeliness,
                        score.source_quality,
                        score.version,
                        _build_score_reason(
                            score,
                            persisted_distilled,
                            limited_score=limited_score,
                            markdown=markdown,
                        ),
                        (
                            json.dumps(persisted_distilled.to_dict(), ensure_ascii=False)
                            if persisted_distilled is not None
                            else None
                        ),
                        (
                            persisted_distilled.tier_score
                            if persisted_distilled is not None
                            and persisted_distilled.tier_score is not None
                            else persisted_distilled.total
                            if persisted_distilled is not None
                            else None
                        ),
                        persisted_distilled.tier if persisted_distilled is not None else None,
                        persisted_distilled.must_read if persisted_distilled is not None else None,
                        persisted_distilled.profile if persisted_distilled is not None else None,
                        interpretation[:2000],
                        run_id,
                        original_markdown,
                        original_kind,
                        original_bytes,
                        content_sha256,
                    ),
                )
            ).fetchone()
    return row is not None


def _build_score_reason(
    score: Any,
    distilled: Any | None,
    *,
    limited_score: bool = False,
    markdown: str = "",
) -> str:
    """Return the reason for the score that the UI actually displays."""
    reason = ""
    if distilled is not None and not distilled.is_default:
        from ai_engine.radar.distilled_scorer import build_distilled_score_reason

        reason = build_distilled_score_reason(distilled)
    else:
        reason = str(score.reason or "")[:500]
    if limited_score and distilled is not None:
        reason = (
            "低置信度初筛：正文不足1000字符，仅用于排序和是否值得继续抓取。"
            + reason
        )[:500]
    shell_label = _shell_content_label(markdown)
    if shell_label:
        reason = (
            "抓取失败: "
            + shell_label
            + " | "
            + (reason or "")
        )[:500]
    return reason


_NAV_NOISE_PATTERNS = [
    "Skip to main content", "Skip to content", "Log in", "Sign in",
    "Try ChatGPT", "Try ChatGPT (opens in a new window)",
    "Navigation menu", "Search", "Create account", "Close",
    "Add reaction", "Like Unicorn", "Jump to Comments",
    "Powered by Algolia", "Back to Articles",
]


def _clean_content(text: str, min_len: int = 200) -> str:
    """Remove navigation noise. Returns empty string if too short after cleaning."""
    if not text or len(text) < min_len:
        return ""
    cleaned = text
    for pattern in _NAV_NOISE_PATTERNS:
        cleaned = cleaned.replace(pattern, "")
    import re as _re
    cleaned = _re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) < min_len:
        return ""
    return cleaned


def _github_repo_signals(candidate: RadarCandidate, markdown: str) -> dict[str, Any]:
    """Combine source metadata with cheap, auditable README evidence."""
    signals = dict(candidate.repo_signals)
    if not signals:
        return {}
    text = markdown or ""
    lowered = text.lower()
    signals.update({
        "readmeChars": len(text),
        "technicalDensity": round(
            sum(1 for token in (
                "tree-sitter", "mcp", "api", "benchmark", "test", "ci",
                "github action", "docker", "deploy", "latency", "token",
            ) if token in lowered) / max(1, len(text) / 1000),
            4,
        ),
        "hasBenchmark": bool(_re.search(r"benchmark|evaluation|\beval\b|performance|latency", lowered)),
        "hasCiAction": bool(_re.search(r"github action|github/workflows|ci/cd|continuous integration", lowered)),
        "hasTests": bool(_re.search(r"\btests?\b|pytest|unit test|test suite", lowered)),
        "hasArchitecture": bool(_re.search(r"architecture|tree-sitter|ast|graph|pipeline|incremental", lowered)),
    })
    return signals


def _is_low_quality_content(text: str) -> bool:
    """Detect content too short to summarize or blocked by a bot check.

    When this returns True the sync runner skips the brief LLM entirely
    and stores the raw snippet instead, so Cloudflare/verification pages
    never get a hallucinated interpretation.
    """
    if not text or len(text.strip()) < 200:
        return True
    lowered = text.lower()
    return any(marker in lowered for marker in _LOW_QUALITY_MARKERS)


def _scoreability(content: str) -> str | None:
    """Classify content before scoring.

    ``limited`` is useful for abstracts and short release notes: it may be
    enough for triage, but is not equivalent to a full article. ``full`` is
    the 1,000-character quality gate. Shells and very short captures remain
    unscorable.
    """
    stripped = content.strip()
    if len(stripped) < MIN_LIMITED_SCORE_CONTENT_CHARS:
        return None
    if (
        _is_low_quality_content(stripped[:2_000])
        and len(stripped) < MIN_FULL_SCORE_CONTENT_CHARS
    ):
        return None
    return (
        "full"
        if len(stripped) >= MIN_FULL_SCORE_CONTENT_CHARS
        else "limited"
    )


def _shell_content_label(text: str) -> str | None:
    """Classify a fetched page as a known fetch-failure shell.

    Returns a short Chinese label suitable for prefixing ``scoreReason`` so
    the UI can distinguish "real noise" from "fetch failure noise". Returns
    ``None`` when the text does not match a known shell pattern.
    """
    lowered = (text or "").lower()
    if not lowered:
        return None
    if any(
        marker in lowered
        for marker in (
            "prove your humanity",
            "verifying your browser",
            "complete the check below",
            "just a moment",
            "enable javascript and cookies",
            "attention required! | cloudflare",
            "are you a robot",
        )
    ):
        return "反爬验证页"
    if any(
        marker in lowered
        for marker in (
            "mark by airtop",
            "vibe automation for marketers",
            "wispr flow",
        )
    ):
        return "推广/重定向页"
    if "article url:" in lowered and "comments url:" in lowered:
        return "仅拿到评论壳"
    if any(
        marker in lowered
        for marker in (
            "未找到页面",
            "404 not found",
            "page not found",
        )
    ):
        return "源站 404"
    if "lobste.rs score:" in lowered:
        return "只有 Lobsters 评分壳"
    return None


def _is_fetch_failure_shell(text: str) -> bool:
    return _shell_content_label(text) is not None


def _content_fetch_failure_reason(
    text: str,
    source_type: str,
    title: str = "",
) -> str | None:
    """Identify a fetched page shell, not a genuinely short article."""
    normalized = " ".join((text or "").split())
    lowered = normalized.lower()
    if not normalized:
        return None
    if "prove your humanity" in lowered or "complete the challenge" in lowered:
        return "bot_challenge"
    if source_type == "reddit" and lowered in {
        "reddit",
        "reddit - prove your humanity",
    }:
        return "reddit_empty_detail"
    if (
        "enable javascript and cookies to continue" in lowered
        or "checking your browser before accessing" in lowered
        or "attention required! | cloudflare" in lowered
        or "performance & security by cloudflare" in lowered
        or "challenge-platform" in lowered
        or "cf-chl-" in lowered
    ):
        return "javascript_or_cloudflare_challenge"
    if source_type == "producthunt" and len(normalized) < 800 and "promoted" in lowered:
        title_tokens = {
            token.lower()
            for token in _re.findall(r"[A-Za-z0-9]{4,}", title or "")
        }
        if title_tokens and not any(token in lowered for token in title_tokens):
            return "producthunt_wrong_page_shell"
    return None


def _is_rate_limited_brief(brief: Any | None = None, exc: BaseException | None = None) -> bool:
    if exc is not None:
        text = str(exc)
    else:
        text = " ".join(
            str(getattr(brief, key, "") or "")
            for key in ("error_code", "error_message")
        )
    lowered = text.lower()
    return (
        "429" in lowered
        or "too many requests" in lowered
        or "rate limit" in lowered
        or "ratelimit" in lowered
    )


async def _generate_brief_with_retry(
    generate_brief: BriefGenerator,
    adapter: ResearchEngineAdapter,
    item: dict[str, Any],
    canonical_url: str,
    *,
    timeout_seconds: float,
    context_max_chars: int | None = None,
) -> Any:
    """Call generate_brief, retrying transient provider failures."""
    last: Any = None
    for attempt in range(_BRIEF_RATE_LIMIT_RETRIES + 1):
        delay = (
            _BRIEF_RATE_LIMIT_BACKOFF[attempt]
            if attempt < len(_BRIEF_RATE_LIMIT_BACKOFF)
            else 0.0
        )
        try:
            brief = await generate_brief(
                adapter,
                item,
                canonical_url,
                timeout_seconds=timeout_seconds,
                context_max_chars=context_max_chars,
            )
            if brief.status == AI_JOB_STATUS["FAILED"] and _is_retryable_brief_failure(brief=brief):
                last = brief
                if delay <= 0:
                    break
                logger.info(
                    "ai-engine.radar.brief_retry",
                    extra={"attempt": attempt + 1, "delay_s": delay},
                )
                await asyncio.sleep(delay)
                continue
            return brief
        except Exception as exc:
            last = exc
            if _is_retryable_brief_failure(exc=exc):
                if delay <= 0:
                    break
                logger.info(
                    "ai-engine.radar.brief_retry",
                    extra={"attempt": attempt + 1, "delay_s": delay},
                )
                await asyncio.sleep(delay)
                continue
            raise
    if isinstance(last, BaseException):
        raise last
    return last


def _is_retryable_brief_failure(
    *,
    brief: Any | None = None,
    exc: BaseException | None = None,
) -> bool:
    text = str(exc) if exc is not None else " ".join(
        str(getattr(brief, key, "") or "")
        for key in ("error_code", "error_message")
    )
    lowered = text.lower()
    return _is_rate_limited_brief(brief=brief, exc=exc) or any(
        marker in lowered
        for marker in (
            "ai_engine_unavailable",
            "worker_timeout",
            "upstream_status_502",
            "upstream_status_503",
            "internalservererror",
            "apitimeout",
            "proxy_error",
        )
    )


def _strip_html_tags(html: str) -> str:
    """Strip HTML tags and collapse whitespace."""
    import re as _re
    text = _re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=_re.DOTALL)
    text = _re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=_re.DOTALL)
    text = _re.sub(r"<nav[^>]*>.*?</nav>", " ", text, flags=_re.DOTALL)
    text = _re.sub(r"<footer[^>]*>.*?</footer>", " ", text, flags=_re.DOTALL)
    text = _re.sub(r"<header[^>]*>.*?</header>", " ", text, flags=_re.DOTALL)
    text = _re.sub(r"<aside[^>]*>.*?</aside>", " ", text, flags=_re.DOTALL)
    text = _re.sub(r"<[^>]+>", " ", text)
    text = _re.sub(r"&nbsp;", " ", text)
    text = _re.sub(r"&amp;", "&", text)
    text = _re.sub(r"&lt;", "<", text)
    text = _re.sub(r"&gt;", ">", text)
    text = _re.sub(r"&quot;", '"', text)
    text = _re.sub(r"&#39;", "'", text)
    text = _re.sub(r"\s+", " ", text).strip()
    return text


def _extract_article_content(
    html: str,
    url: str,
    source_type: str,
    *,
    max_bytes: int = ORIGINAL_MARKDOWN_MAX_BYTES,
) -> str:
    """Extract clean article text from HTML, optimized per source type.

    Each source type has a different page structure. We try to extract
    the main content block, not the entire page with nav/sidebar/footer.
    Falls back to html_to_markdown (whole page) if extraction fails.
    """
    import re as _re

    # Prefer a real article extractor for prose pages. The previous fallback
    # stripped tags with regexes, which preserved text but destroyed headings,
    # paragraphs, and lists. Trafilatura returns Markdown with those blocks
    # intact. If extraction fails, source-specific parsers below still provide
    # safe fallbacks for arXiv and GitHub.
    try:
        from ai_engine.radar.structured_html import structured_html_to_markdown

        structured = structured_html_to_markdown(html, url)
        if len(structured.strip()) >= 200:
            return normalize_markdown(structured)[:max_bytes]
    except Exception as exc:  # structure recovery is an enhancement, never a sync blocker
        logger.debug("structured HTML extraction failed", extra={"url": url[:2048], "error": str(exc)})

    try:
        import trafilatura

        extracted = trafilatura.extract(
            html,
            url=url,
            output_format="markdown",
            include_comments=False,
            include_tables=True,
            include_links=True,
            favor_precision=True,
        )
        if extracted and len(extracted.strip()) >= 200:
            return normalize_markdown(extracted)[:max_bytes]
    except Exception as exc:  # extraction is an enhancement, never a sync blocker
        logger.debug("trafilatura extraction failed", extra={"url": url[:2048], "error": str(exc)})

    # ── ArXiv: extract abstract from <blockquote class="abstract"> ──
    if source_type == "arxiv" or "arxiv.org/abs/" in url:
        m = _re.search(
            r'<blockquote[^>]*class="[^"]*abstract[^"]*"[^>]*>(.*?)</blockquote>',
            html, _re.DOTALL | _re.IGNORECASE,
        )
        if m:
            abstract = _strip_html_tags(m.group(1))
            if len(abstract) > 50:
                return normalize_markdown(abstract)[:8000]

    # ── GitHub: extract README article content ──
    if source_type in ("github", "github_trending") or "github.com" in url:
        # Try <article> tag (GitHub wraps README in <article class="markdown-body">)
        m = _re.search(
            r'<article[^>]*class="[^"]*markdown-body[^"]*"[^>]*>(.*?)</article>',
            html, _re.DOTALL | _re.IGNORECASE,
        )
        if m:
            readme = _strip_html_tags(m.group(1))
            if len(readme) > 100:
                return normalize_markdown(readme)[:8000]
        # Fallback: try <div id="readme">
        m = _re.search(r'<div[^>]*id="readme"[^>]*>(.*?)</div>\s*</div>',
                        html, _re.DOTALL | _re.IGNORECASE)
        if m:
            readme = _strip_html_tags(m.group(1))
            if len(readme) > 100:
                return normalize_markdown(readme)[:8000]

    # ── Dev.to: extract <div id="article-body"> ──
    if source_type == "devto" or "dev.to" in url:
        m = _re.search(
            r'<div[^>]*id="article-body"[^>]*>(.*?)</div>\s*</div>',
            html, _re.DOTALL | _re.IGNORECASE,
        )
        if m:
            body = _strip_html_tags(m.group(1))
            if len(body) > 100:
                return normalize_markdown(body)[:8000]

    # ── Generic: strip nav/header/footer/aside, then extract <main> or <article> ──
    # Try <main> tag first
    m = _re.search(r"<main[^>]*>(.*?)</main>", html, _re.DOTALL | _re.IGNORECASE)
    if m:
        body = _strip_html_tags(m.group(1))
        if len(body) > 100:
            return normalize_markdown(body)[:8000]
    # Try <article> tag
    m = _re.search(r"<article[^>]*>(.*?)</article>", html, _re.DOTALL | _re.IGNORECASE)
    if m:
        body = _strip_html_tags(m.group(1))
        if len(body) > 100:
            return normalize_markdown(body)[:8000]
    # Last resort: strip known noise sections from full page
    cleaned = _strip_html_tags(html)
    if len(cleaned) > 200:
        return normalize_markdown(cleaned)[:8000]
    # Absolute fallback: original html_to_markdown
    return normalize_markdown(html_to_markdown(html))[:8000]


def _snippet_document(url: str, snippet: str) -> FetchedDocument:
    """Build a document from source-provided text without a second HTTP fetch."""
    content = snippet.strip().encode("utf-8")
    return FetchedDocument(
        url=url,
        final_ip="",
        status=200,
        headers={"content-type": "text/plain"},
        content=content,
        content_type="text/plain",
        elapsed_ms=0,
        redirect_count=0,
    )


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
    distilled_scorer: DistilledScorerFn | None = None,
    monitor: Any | None = None,
    embedding_scorer: EmbeddingScorerFn | None = None,
    candidate_concurrency: int | None = None,
) -> SourceRunResult:
    run_id = await _create_run(pool, source, triggered_by)
    started = time.monotonic()
    total_fetched = total_new = total_skipped = total_failed = 0
    fallback_count = 0
    skipped_existing = 0
    skipped_rule_noise = 0
    skipped_distilled_noise = 0
    skipped_conflict = 0
    token_in = token_out = 0
    cost_usd = 0.0
    first_error_code: str | None = None
    candidate_failures: Counter[tuple[str, str, str]] = Counter()
    unavailable_hosts: set[str] = set()
    unavailable_hosts_lock = asyncio.Lock()
    source_diagnostic: tuple[str, str] | None = None
    try:
        candidates = await _with_transport_retries(
            lambda: fetch_source(source, fetchers=fetchers),
            run_id=run_id,
            source_id=source.id,
            domain=_source_domain(source),
        )
        await _heartbeat_run(pool, run_id)
        total_fetched = len(candidates)
        raw_diagnostic = source.config.get("_wewe_refresh_diagnostic")
        source_diagnostic = (
            raw_diagnostic
            if isinstance(raw_diagnostic, tuple)
            and len(raw_diagnostic) == 2
            and all(isinstance(value, str) for value in raw_diagnostic)
            else next(
                (candidate.source_diagnostic for candidate in candidates if candidate.source_diagnostic),
                None,
            )
        )
        candidate_semaphore = asyncio.Semaphore(
            max(1, candidate_concurrency or RADAR_CANDIDATE_CONCURRENCY)
        )

        async def _process_candidate(raw_candidate: RadarCandidate) -> None:
            nonlocal total_new, total_skipped, total_failed
            nonlocal fallback_count, skipped_existing, skipped_rule_noise
            nonlocal skipped_distilled_noise, skipped_conflict
            nonlocal token_in, token_out, cost_usd, first_error_code

            async with candidate_semaphore:
                try:
                    normalized = normalize_candidate(raw_candidate)
                    markdown = ""
                    existing = await _existing_candidate(pool, normalized.canonical_url)
                    if existing is not None:
                        existing_id = str(existing["id"])
                        if _needs_content_retry(existing):
                            await _retry_existing_summary_content(
                                pool,
                                summary_id=existing_id,
                                candidate=raw_candidate,
                                canonical_url=normalized.canonical_url,
                                source=source,
                                run_id=run_id,
                                document_fetcher=document_fetcher,
                                generate_brief=generate_brief,
                                adapter=adapter,
                                timeout_seconds=generation_timeout_seconds,
                            )
                        total_skipped += 1
                        skipped_existing += 1
                        return

                    # Heuristic score (for admin-queue sort only) + noise-pattern filter.
                    score = score_candidate(normalized, source_type=source.source_type)
                    filter_result = filter_candidate(normalized, score, source.source_type)
                    if not filter_result.keep:
                        await _record_sync_diagnostic(
                            pool,
                            source=source,
                            run_id=run_id,
                            candidate=raw_candidate,
                            canonical_url=normalized.canonical_url,
                            kind="filtered",
                            reason_code="RULE_NOISE",
                            reason_message=filter_result.reason,
                            body=normalized.snippet,
                        )
                        total_skipped += 1
                        skipped_rule_noise += 1
                        return

                    if source.source_type == "arxiv" and normalized.snippet.strip():
                        # The arXiv API already returns the abstract. Fetching
                        # every /abs page afterwards multiplies one upstream
                        # request into 50 rate-limited page requests.
                        markdown = normalized.snippet.strip()[:8000]
                        fetched = _snippet_document(raw_candidate.url, markdown)
                    else:
                        document_host = _host(raw_candidate.url)
                        # A source batch often contains many links on one host
                        # (ArXiv, Dev.to, GitHub). Once transport fails for a
                        # host, retrying every remaining candidate only turns a
                        # single outage into dozens of identical failures.
                        async with unavailable_hosts_lock:
                            host_unavailable = document_host in unavailable_hosts
                        if host_unavailable:
                            total_skipped += 1
                            await _record_sync_diagnostic(
                                pool,
                                source=source,
                                run_id=run_id,
                                candidate=raw_candidate,
                                canonical_url=normalized.canonical_url,
                                kind="filtered",
                                reason_code="HOST_CIRCUIT_OPEN",
                                reason_message="同一主机前序抓取失败，后续候选跳过重试",
                                body=normalized.snippet,
                            )
                            logger.info(
                                "ai-engine.radar.host_circuit_open",
                                extra={
                                    "request_id": run_id,
                                    "source_id": source.id,
                                    "domain": document_host,
                                },
                            )
                            return
                        try:
                            fetched, markdown = await _fetch_document_with_content_retries(
                                document_fetcher,
                                url=raw_candidate.url,
                                source_type=source.source_type,
                                run_id=run_id,
                                source_id=source.id,
                                domain=document_host,
                            )
                        except Exception as fetch_exc:
                            if (
                                _can_use_snippet_fallback(source, raw_candidate)
                                or _can_use_candidate_metadata_fallback(source, raw_candidate)
                            ):
                                fallback_count += 1
                                markdown = raw_candidate.snippet.strip()[:8000]
                                fetched = _snippet_document(
                                    raw_candidate.url, markdown
                                )
                                logger.info(
                                    "ai-engine.radar.snippet_transport_fallback",
                                    extra={
                                        "request_id": run_id,
                                        "source_id": source.id,
                                        "error_code": _safe_error_code(fetch_exc),
                                        "domain": document_host,
                                    },
                                )
                            else:
                                if _is_retryable_transport_error(fetch_exc):
                                    async with unavailable_hosts_lock:
                                        unavailable_hosts.add(document_host)
                                raise
                    raw_content = markdown or normalized.snippet
                    content_failure_reason = _content_fetch_failure_reason(
                        raw_content,
                        source.source_type,
                        normalized.title,
                    )
                    if (
                        content_failure_reason
                        and not _can_use_candidate_metadata_fallback(
                            source,
                            raw_candidate,
                        )
                    ):
                        fallback_count += 1
                        await _record_sync_diagnostic(
                            pool,
                            source=source,
                            run_id=run_id,
                            candidate=raw_candidate,
                            canonical_url=normalized.canonical_url,
                            kind="filtered",
                            reason_code=_CONTENT_FETCH_FAILURE_CODE,
                            reason_message=(
                                f"正文抓取失败：{content_failure_reason}"
                            ),
                            error_type="ContentFetchFailure",
                            error_domain=_host(raw_candidate.url),
                            body=raw_content,
                            markdown=markdown,
                        )
                        total_skipped += 1
                        return
                    metadata_only_fallback = False
                    low_quality = _is_low_quality_content(raw_content)
                    brief: Any = None
                    interpretation = ""
                    if low_quality:
                        # Page fetch landed on a bot check (Cloudflare etc.) or a
                        # too-short shell. Any fallback path counts as 1 fallback
                        # regardless of whether we use the snippet as LLM context.
                        fallback_count += 1
                        # If the fetcher supplied a snippet (even if short, like
                        # a Product Hunt tagline), skip the LLM brief step but
                        # **let the row keep the raw markdown as its body** so
                        # the Admin can still review the page contents. We
                        # intentionally leave ``interpretation`` empty here so
                        # ``_insert_candidate`` falls through to ``markdown``
                        # (not the snippet) when building the summary body.
                        snippet_clean = normalized.snippet.strip()
                        use_metadata_fallback = _can_use_candidate_metadata_fallback(
                            source, raw_candidate
                        )
                        metadata_only_fallback = use_metadata_fallback
                        if (
                            use_metadata_fallback
                            or (
                                len(snippet_clean) >= 200
                                and not any(
                                    m in snippet_clean.lower()
                                    for m in _LOW_QUALITY_MARKERS
                                )
                            )
                        ):
                            logger.info(
                                "ai-engine.radar.low_quality_page_use_snippet",
                                extra={
                                    "request_id": run_id,
                                    "source_id": source.id,
                                    "title": normalized.title[:200],
                                    "url": normalized.url[:2048],
                                    "metadata_only": use_metadata_fallback,
                                },
                            )
                            # A sufficiently long source snippet is an explicit
                            # fallback, so it can still go through brief + score.
                            markdown = snippet_clean
                            raw_content = snippet_clean
                            brief_context = snippet_clean
                            low_quality = False
                        else:
                            logger.info(
                                "ai-engine.radar.low_quality_skip",
                                extra={
                                    "request_id": run_id,
                                    "source_id": source.id,
                                    "title": normalized.title[:200],
                                    "url": normalized.url[:2048],
                                },
                            )
                            await _record_sync_diagnostic(
                                pool,
                                source=source,
                                run_id=run_id,
                                candidate=raw_candidate,
                                canonical_url=normalized.canonical_url,
                                kind="filtered",
                                reason_code="LOW_QUALITY",
                                reason_message="抓取内容不足以完成评分或解读",
                                body=markdown or normalized.snippet,
                                markdown=markdown,
                            )
                            total_skipped += 1
                            return
                    else:
                        brief_context = markdown or normalized.snippet

                    github_repo_candidate = _is_github_repo_candidate(
                        source,
                        raw_candidate,
                    )
                    item = {
                        "title": normalized.title,
                        "snippet": brief_context[:2000],
                    }
                    # 低质量 fallback（snippet 路径）已直接用 snippet 作 interpretation，跳过 LLM
                    if not low_quality:
                        try:
                            brief = await _generate_brief_with_retry(
                                generate_brief,
                                adapter,
                                item,
                                normalized.canonical_url,
                                timeout_seconds=generation_timeout_seconds,
                                context_max_chars=None,
                            )
                            token_in += brief.cost.token_input_total
                            token_out += brief.cost.token_output_total
                            cost_usd += _cost_usd(brief.cost)
                            if brief.status != AI_JOB_STATUS["SUCCEEDED"] or not brief.output_text:
                                brief_code = str(
                                    getattr(brief, "error_code", None)
                                    or "AI_ENGINE_UNAVAILABLE"
                                )
                                brief_message = str(
                                    getattr(brief, "error_message", None)
                                    or f"brief generation ended in {brief.status}"
                                )
                                raise _BriefGenerationError(
                                    brief_code,
                                    brief_message,
                                )
                            interpretation = _strip_reasoning_markup(brief.output_text)
                            if len(interpretation) < MIN_BRIEF_OUTPUT_CHARS:
                                logger.warning(
                                    "ai-engine.radar.brief_output_short",
                                    extra={
                                        "request_id": run_id,
                                        "source_id": source.id,
                                        "title": normalized.title[:200],
                                        "output_length": len(interpretation),
                                        "content_length": len(raw_content),
                                    },
                                )
                                # A terse model answer is not a useful summary;
                                # let the captured article become the visible body.
                                interpretation = ""
                        except Exception as brief_exc:
                            if not (
                                _can_use_snippet_fallback(source, raw_candidate)
                                or _can_use_candidate_metadata_fallback(
                                    source, raw_candidate
                                )
                                or len(raw_content.strip()) >= 200
                            ):
                                raise
                            fallback_count += 1
                            brief = None
                            interpretation = ""
                            logger.info(
                                "ai-engine.radar.snippet_brief_fallback",
                                extra={
                                    "request_id": run_id,
                                    "source_id": source.id,
                                    "error_code": _safe_error_code(brief_exc),
                                },
                            )
                    # Distilled 7-dimension LLM scoring (Stage 2)
                    distilled_result = None
                    scoreability = None
                    # A curated GitHub repository still needs one score when
                    # its HTML page is blocked.  In that case the API
                    # description + repo_signals are the only available
                    # evidence, so skip the generic brief but do not skip the
                    # tier decision.
                    if distilled_scorer is not None and (
                        not metadata_only_fallback or github_repo_candidate
                    ):
                        from ai_engine.scoring.scoring_profiles import profile_for_source

                        profile, _ = profile_for_source(source.source_type)
                        cleaned = _clean_content(raw_content)
                        scoreability = _scoreability(cleaned)
                        if github_repo_candidate and scoreability is None:
                            repo_context = "\n".join(
                                part for part in (
                                    f"GitHub 仓库：{normalized.title}",
                                    f"仓库可见描述：{normalized.snippet.strip()}",
                                    "页面正文不可用；请仅依据仓库描述与结构化证据，"
                                    "对工程价值和适用范围做保守评分。",
                                )
                                if part.strip()
                            )
                            cleaned = repo_context
                            scoreability = "limited"
                        if github_repo_candidate or scoreability is not None:
                            distilled_result = await distilled_scorer(
                                normalized.title,
                                cleaned,
                                profile=profile,
                                source_type=source.source_type,
                                url=normalized.url,
                                published_at=normalized.published_at,
                                structured_signals=(
                                    _github_repo_signals(raw_candidate, raw_content)
                                    if source.source_type.startswith("github")
                                    else None
                                ),
                            )
                        else:
                            from ai_engine.radar.distilled_scorer import default_score
                            distilled_result = default_score(profile)
                        if distilled_result.is_default:
                            fallback_count += 1
                        if monitor is not None:
                            monitor.record(distilled_result)
                        if distilled_result.is_default:
                            await _record_sync_diagnostic(
                                pool,
                                source=source,
                                run_id=run_id,
                                candidate=raw_candidate,
                                canonical_url=normalized.canonical_url,
                                kind="filtered",
                                reason_code="PENDING_SCORE",
                                reason_message="评分未完成，已保留在数据库等待治理",
                                body=_best_content_body(
                                    interpretation, markdown, normalized.snippet
                                ),
                                markdown=markdown,
                            )
                    extra_tags_list = ["pr_soft"] if filter_result.is_pr else []
                    if metadata_only_fallback:
                        extra_tags_list.append("content_pending")
                        if source.source_type in {"github", "github_trending"}:
                            extra_tags_list.append("github_content_pending")
                    # Persist every scored result, including tier=noise. The
                    # public radar/search surfaces apply the quality gate;
                    # Admin governance keeps the diagnostic for review.
                    if (
                        distilled_result is not None
                        and brief is not None
                        and getattr(distilled_result, "tier", None) == "noise"
                    ):
                        logger.info(
                            "ai-engine.radar.noise_skipped",
                            extra={
                                "request_id": run_id,
                                "source_id": source.id,
                                "title": normalized.title[:200],
                                "url": normalized.url[:2048],
                            },
                        )
                        dimension_scores = getattr(distilled_result, "dimension_scores", {}) or {}
                        if getattr(distilled_result, "veto", None):
                            noise_reason_code = "DISTILLED_HARD_VETO"
                        elif dimension_scores and all(
                            value == 0 for value in dimension_scores.values()
                        ):
                            noise_reason_code = "DISTILLED_UNASSESSABLE"
                        else:
                            noise_reason_code = "DISTILLED_NOISE"
                        await _record_sync_diagnostic(
                            pool,
                            source=source,
                            run_id=run_id,
                            candidate=raw_candidate,
                            canonical_url=normalized.canonical_url,
                            kind="filtered",
                            reason_code=noise_reason_code,
                            reason_message=getattr(distilled_result, "weak_point", None),
                            distilled=distilled_result,
                            body=_best_content_body(
                                interpretation, markdown, normalized.snippet
                            ),
                            markdown=markdown,
                        )

                    inserted = await _insert_candidate(
                        pool,
                        candidate=raw_candidate,
                        canonical_url=normalized.canonical_url,
                        fetched=fetched,
                        markdown=markdown,
                        interpretation=interpretation,
                        source=source,
                        run_id=run_id,
                        score=score,
                        cost=(
                            brief.cost
                            if brief is not None
                            else CostMetrics(0, 0, 0, 0)
                        ),
                        extra_tags=tuple(extra_tags_list),
                        distilled=distilled_result,
                        limited_score=scoreability == "limited",
                    )
                    if inserted:
                        total_new += 1
                    else:
                        total_skipped += 1
                        skipped_conflict += 1
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
                    error_code = _safe_error_code(exc)
                    error_domain = _error_domain(exc, _host(raw_candidate.url))
                    first_error_code = first_error_code or error_code
                    candidate_failures[(
                        error_code,
                        type(exc).__name__,
                        error_domain,
                    )] += 1
                    logger.warning(
                        "ai-engine.radar.candidate_failed",
                        extra={
                            "request_id": run_id,
                            "source_id": source.id,
                            "domain": error_domain,
                            "error_code": error_code,
                            "error_type": type(exc).__name__,
                        },
                    )
                    try:
                        diagnostic_url = normalize_candidate(raw_candidate).canonical_url
                    except Exception:
                        diagnostic_url = raw_candidate.url
                    await _record_sync_diagnostic(
                        pool,
                        source=source,
                        run_id=run_id,
                        candidate=raw_candidate,
                        canonical_url=diagnostic_url,
                        kind="failed",
                        reason_code=error_code,
                        reason_message=str(exc)[:500],
                        error_type=type(exc).__name__,
                        error_domain=error_domain,
                        body=raw_candidate.snippet,
                    )
                finally:
                    await _heartbeat_run(pool, run_id)

        await asyncio.gather(*(_process_candidate(candidate) for candidate in candidates))
        run_status = "partial" if total_failed else "completed"
        error_message = (
            _format_failure_summary(candidate_failures, prefix="candidate failures")
            if total_failed
            else None
        )
        if source_diagnostic is not None:
            diagnostic_code, diagnostic_message = source_diagnostic
            first_error_code = first_error_code or diagnostic_code
            error_message = diagnostic_message
            if run_status == "completed":
                run_status = "partial"
    except Exception as exc:
        total_failed = max(1, total_failed)
        first_error_code = _safe_error_code(exc)
        run_status = "failed"
        source_failure = Counter({(
            first_error_code,
            type(exc).__name__,
            _error_domain(exc, _source_domain(source)),
        ): 1})
        error_message = _format_failure_summary(
            source_failure,
            prefix="source failure",
        )
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
        fallback_count=fallback_count,
        skipped_existing=skipped_existing,
        skipped_rule_noise=skipped_rule_noise,
        skipped_distilled_noise=skipped_distilled_noise,
        skipped_conflict=skipped_conflict,
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
        fallback_count=fallback_count,
        skipped_existing=skipped_existing,
        skipped_rule_noise=skipped_rule_noise,
        skipped_distilled_noise=skipped_distilled_noise,
        skipped_conflict=skipped_conflict,
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
    distilled_scorer: DistilledScorerFn | None = None,
    monitor: Any | None = None,
    embedding_scorer: EmbeddingScorerFn | None = None,
    source_concurrency: int | None = None,
    candidate_concurrency: int | None = None,
) -> RadarSyncResult:
    """Run all enabled sources independently and return source-level results."""

    if triggered_by not in {"cron", "admin"}:
        raise ValueError("triggered_by must be cron or admin")
    sources = await load_enabled_sources(pool)
    if source_ids is not None:
        sources = [source for source in sources if source.id in source_ids]
    engine = adapter or build_adapter()
    batch_id = str(uuid.uuid4())
    source_semaphore = asyncio.Semaphore(max(1, source_concurrency or RADAR_SOURCE_CONCURRENCY))

    async def _run_bounded(source: RadarSource) -> SourceRunResult:
        async with source_semaphore:
            return await _run_source(
                pool,
                source=source,
                triggered_by=triggered_by,
                adapter=engine,
                fetchers=fetchers,
                document_fetcher=document_fetcher,
                generate_brief=generate_brief,
                generation_timeout_seconds=generation_timeout_seconds,
                distilled_scorer=distilled_scorer,
                monitor=monitor,
                embedding_scorer=embedding_scorer,
                candidate_concurrency=candidate_concurrency,
            )

    results = await asyncio.gather(
        *(_run_bounded(source) for source in sources)
    )
    return RadarSyncResult(batch_id=batch_id, runs=tuple(results))


async def run_radar_pipeline(
    pool: Any,
    *,
    target_date: date | None = None,
    **sync_kwargs: Any,
) -> RadarPipelineResult:
    """Run sync, post-processing and enrichment.

    Enrichment only sees summaries inserted by this sync's source-run IDs.
    Later-stage failures do not roll back successfully persisted earlier
    stages; they are returned for reporting and can be retried independently.
    """
    sync_result = await run_radar_sync(pool, **sync_kwargs)
    all_runs = list(sync_result.runs)
    triggered_by = str(sync_kwargs.get("triggered_by", "cron"))
    # Retry only the sources that failed or were partial. Successful sources
    # are never re-fetched, so a flaky upstream cannot duplicate the whole
    # daily batch. The retry creates its own run record for observability.
    if RADAR_SOURCE_RETRIES > 0:
        for attempt in range(RADAR_SOURCE_RETRIES):
            retry_source_ids = _retryable_latest_source_ids(all_runs)
            if not retry_source_ids:
                break
            if any(
                result.error_code in {"UPSTREAM_RATE_LIMITED", "AI_ENGINE_UNAVAILABLE"}
                for result in all_runs
                if result.source_id in retry_source_ids
            ):
                delay = RADAR_RATE_LIMIT_RETRY_BACKOFF_SECONDS * (attempt + 1)
            else:
                delay = RADAR_SOURCE_RETRY_BACKOFF_SECONDS * (attempt + 1)
            if delay:
                await asyncio.sleep(delay)
            retry_result = await run_radar_sync(
                pool,
                **{
                    **sync_kwargs,
                    "source_ids": retry_source_ids,
                },
            )
            all_runs.extend(retry_result.runs)
    sync_result = RadarSyncResult(
        batch_id=sync_result.batch_id,
        runs=tuple(all_runs),
    )
    started = time.monotonic()
    try:
        from ai_engine.radar.candidate_postprocessor import (
            score_missing_candidates,
        )
        from ai_engine.radar.enrichment_worker import run_enrichment_for_pending

        total_new = sum(run.total_new for run in sync_result.runs)
        await score_missing_candidates(
            pool,
            limit=max(20, total_new),
        )
        enriched_count = 0
        enrichment_attempts = RADAR_ENRICHMENT_RETRIES if triggered_by == "cron" else 0
        enrichment_limit = max(50, total_new) if triggered_by == "cron" else max(1, total_new)
        for attempt in range(enrichment_attempts + 1):
            enriched_count += await run_enrichment_for_pending(
                pool,
                limit=enrichment_limit,
                sync_run_ids=tuple(run.run_id for run in sync_result.runs),
            )
            if attempt < RADAR_ENRICHMENT_RETRIES:
                await asyncio.sleep(2.0 * (attempt + 1))
        # Enrichment can replace a pending/short source capture with the real
        # article. Only score after that replacement; otherwise the fallback
        # snippet can be incorrectly persisted as tier=noise.
        if enriched_count > 0:
            await score_missing_candidates(
                pool,
                limit=max(20, enriched_count),
            )
        enrichment_error = None
    except Exception as exc:
        enriched_count = 0
        enrichment_error = f"{type(exc).__name__}: {str(exc)[:200]}"
        logger.warning(
            "ai-engine.radar.enrichment_stage_failed",
            extra={"error_type": type(exc).__name__},
        )
    enrichment_elapsed_ms = int((time.monotonic() - started) * 1000)
    return RadarPipelineResult(
        sync=sync_result,
        enriched_count=enriched_count,
        enrichment_elapsed_ms=enrichment_elapsed_ms,
        enrichment_error=enrichment_error,
    )


async def retry_radar_run(
    pool: Any,
    run_id: str,
    *,
    adapter: ResearchEngineAdapter | None = None,
    fetchers: dict[str, SourceFetcher] | None = None,
    document_fetcher: SafeFetcher = safe_fetch,
    generate_brief: BriefGenerator = _generate_brief,
    distilled_scorer: DistilledScorerFn | None = None,
    monitor: Any | None = None,
    embedding_scorer: EmbeddingScorerFn | None = None,
    candidate_concurrency: int | None = None,
) -> RadarSyncResult:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "sourceId" FROM "radar_sync_runs" WHERE "id" = %s ',
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
        distilled_scorer=distilled_scorer,
        monitor=monitor,
        embedding_scorer=embedding_scorer,
        candidate_concurrency=candidate_concurrency,
    )


__all__ = [
    "RadarPipelineResult",
    "RadarSyncResult",
    "SourceRunResult",
    "retry_radar_run",
    "run_radar_pipeline",
    "run_radar_sync",
]
