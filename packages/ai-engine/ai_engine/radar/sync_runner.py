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
from datetime import date, datetime
from typing import Any, cast
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from ai_engine.adapters.base import CostMetrics, ResearchEngineAdapter, build_adapter
from ai_engine.contracts.states import AI_JOB_STATUS
from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError, safe_fetch
from ai_engine.ingestion.pipeline import _generate_brief
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

# Phase 0 deep-dive: original markdown is capped to 64KB to keep Postgres
# rows under the TOAST threshold and chat prompt snapshot under 50KB.
ORIGINAL_MARKDOWN_MAX_BYTES = 65_536

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
RADAR_DIGEST_RETRIES = max(0, int(os.environ.get("RADAR_DIGEST_RETRIES", "2")))

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

# Tracked-repo digests carry structured GitHub API data (issues/PRs/
# releases) instead of an HTML page. The combined activity feed is the LLM
# context, capped below the 64KB deep-dive limit so one prompt can cover a
# whole repo's 24h activity.
_REPO_DIGEST_CONTEXT_MAX_CHARS = 8000

# These sources provide a meaningful title/snippet in their API response.
# A blocked detail page must not turn an otherwise usable signal into a hard
# candidate failure.
_SNIPPET_FALLBACK_SOURCE_TYPES = {
    "hackernews", "producthunt", "reddit", "lobsters", "devto",
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
    if "arxiv.org/abs/" in u or source_type == "arxiv":
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
    """One complete radar task, including the generated daily digest."""

    sync: RadarSyncResult
    tracked_repo_result: dict[str, int]
    enriched_count: int
    enrichment_elapsed_ms: int
    enrichment_error: str | None = None
    digest_summary_id: str | None = None
    digest_candidate_count: int = 0
    digest_narrative_degraded: bool = False
    digest_elapsed_ms: int = 0
    digest_error: str | None = None


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
      ``URL_FETCH_BLOCKED`` (everything else — DNS, connect, TLS, protocol)
    - ``RuntimeError`` raised by ``ingestion.sources.fetch_arxiv`` (prefix
      ``arxiv_*``) → specific codes so dashboards can split transport
      failures from rate-limit hits and parse errors
    - anything else → ``AI_ENGINE_UNAVAILABLE`` (genuine unknown)
    """
    if isinstance(exc, SafeFetchError):
        return exc.code
    if isinstance(exc, socket.gaierror):
        return "URL_FETCH_DNS"
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
            return "UPSTREAM_RATE_LIMITED"
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
    }


def _can_use_snippet_fallback(source: RadarSource, candidate: RadarCandidate) -> bool:
    return (
        source.source_type in _SNIPPET_FALLBACK_SOURCE_TYPES
        and bool(candidate.snippet.strip())
    )


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
    extra_tags: tuple[str, ...] = (),
    distilled: Any | None = None,
) -> bool:
    candidate_title = (candidate.title or "").strip()
    # RSS feeds occasionally provide a missing-title placeholder. Treat it as
    # missing so the fetched page title can be recovered from HTML/Markdown.
    if candidate_title.casefold() in {"untitled", "(no title)", "no title"}:
        candidate_title = ""
    title = candidate_title or _infer_title(fetched, markdown)

    merged_tags = list(candidate.tags) + list(extra_tags)
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
    # Prefer the AI-generated interpretation as the display body.
    # Raw scraped markdown is noisy (nav menus, footers) for sites like GitHub.
    body = interpretation or candidate.snippet or markdown[:2000]
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
                        _build_score_reason(score, persisted_distilled),
                        (
                            json.dumps(persisted_distilled.to_dict(), ensure_ascii=False)
                            if persisted_distilled is not None
                            else None
                        ),
                        (
                            persisted_distilled.ranking_score
                            if persisted_distilled is not None
                            and persisted_distilled.ranking_score is not None
                            else persisted_distilled.effective_total
                            if persisted_distilled is not None
                            and persisted_distilled.effective_total is not None
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


def _build_score_reason(score: Any, distilled: Any | None) -> str:
    """Combine heuristic score reason with Distilled dimensions."""
    parts = [score.reason]
    if distilled is not None and not distilled.is_default:
        dim_str = ", ".join(
            f"{k}={v}" for k, v in distilled.dimension_scores.items()
        )
        parts.append(
            f"Distilled: {distilled.total:.1f}/100 "
            f"({distilled.tier}, must_read={distilled.must_read}); "
            f"维度: {dim_str}; 弱项: {distilled.weak_point}"
        )
    return " | ".join(parts)[:500]


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
    """Call generate_brief, retrying HTTP-429 failures with 5/10/20s backoff."""
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
            if (
                brief.status == AI_JOB_STATUS["FAILED"]
                and _is_rate_limited_brief(brief=brief)
            ):
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
            if _is_rate_limited_brief(exc=exc):
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


def _extract_article_content(html: str, url: str, source_type: str) -> str:
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
            return extracted.strip()[:ORIGINAL_MARKDOWN_MAX_BYTES]
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
                return abstract[:8000]

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
                return readme[:8000]
        # Fallback: try <div id="readme">
        m = _re.search(r'<div[^>]*id="readme"[^>]*>(.*?)</div>\s*</div>',
                        html, _re.DOTALL | _re.IGNORECASE)
        if m:
            readme = _strip_html_tags(m.group(1))
            if len(readme) > 100:
                return readme[:8000]

    # ── Dev.to: extract <div id="article-body"> ──
    if source_type == "devto" or "dev.to" in url:
        m = _re.search(
            r'<div[^>]*id="article-body"[^>]*>(.*?)</div>\s*</div>',
            html, _re.DOTALL | _re.IGNORECASE,
        )
        if m:
            body = _strip_html_tags(m.group(1))
            if len(body) > 100:
                return body[:8000]

    # ── Generic: strip nav/header/footer/aside, then extract <main> or <article> ──
    # Try <main> tag first
    m = _re.search(r"<main[^>]*>(.*?)</main>", html, _re.DOTALL | _re.IGNORECASE)
    if m:
        body = _strip_html_tags(m.group(1))
        if len(body) > 100:
            return body[:8000]
    # Try <article> tag
    m = _re.search(r"<article[^>]*>(.*?)</article>", html, _re.DOTALL | _re.IGNORECASE)
    if m:
        body = _strip_html_tags(m.group(1))
        if len(body) > 100:
            return body[:8000]
    # Last resort: strip known noise sections from full page
    cleaned = _strip_html_tags(html)
    if len(cleaned) > 200:
        return cleaned[:8000]
    # Absolute fallback: original html_to_markdown
    return html_to_markdown(html)[:8000]


def _repo_activity_document(url: str, markdown: str) -> FetchedDocument:
    """Build a synthetic fetched document for API-sourced repo digests.

    Tracked-repo candidates already carry the full activity payload, so the
    sync runner should not re-fetch the repo HTML page. This placeholder
    keeps the rest of the pipeline (insert, logging) on the same contract.
    """
    return FetchedDocument(
        url=url,
        final_ip="",
        status=200,
        headers={"content-type": "text/markdown"},
        content=markdown.encode("utf-8"),
        content_type="text/markdown",
        elapsed_ms=0,
        redirect_count=0,
    )


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
                    if await _candidate_exists(pool, normalized.canonical_url):
                        total_skipped += 1
                        skipped_existing += 1
                        return

                    # Heuristic score (for admin-queue sort only) + noise-pattern filter.
                    score = score_candidate(normalized, source_type=source.source_type)
                    filter_result = filter_candidate(normalized, score, source.source_type)
                    if not filter_result.keep:
                        total_skipped += 1
                        skipped_rule_noise += 1
                        return

                    repo_activity = raw_candidate.repo_activity
                    if repo_activity is not None:
                        from ai_engine.radar.github_tracked import format_repo_activity

                        markdown = format_repo_activity(
                            repo_activity,
                            max_chars=_REPO_DIGEST_CONTEXT_MAX_CHARS,
                        )
                        fetched = _repo_activity_document(raw_candidate.url, markdown)
                    elif source.source_type == "arxiv" and normalized.snippet.strip():
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
                            fetched = await _with_transport_retries(
                                lambda: document_fetcher(raw_candidate.url),
                                run_id=run_id,
                                source_id=source.id,
                                domain=document_host,
                            )
                        except Exception as fetch_exc:
                            if _can_use_snippet_fallback(source, raw_candidate):
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
                        if not markdown:
                            raw_html = fetched.content.decode("utf-8", errors="replace")
                            markdown = _extract_article_content(
                                raw_html, raw_candidate.url, source.source_type
                            )
                    raw_content = markdown or normalized.snippet
                    # Tracked-repo digests are structured API data: always run
                    # the per-repo LLM summary over the combined activity rather
                    # than treating a short digest as a low-quality scrape.
                    low_quality = (
                        repo_activity is None and _is_low_quality_content(raw_content)
                    )
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
                        if snippet_clean and not any(
                            m in snippet_clean.lower() for m in _LOW_QUALITY_MARKERS
                        ):
                            logger.info(
                                "ai-engine.radar.low_quality_page_use_snippet",
                                extra={
                                    "request_id": run_id,
                                    "source_id": source.id,
                                    "title": normalized.title[:200],
                                    "url": normalized.url[:2048],
                                },
                            )
                            brief_context = snippet_clean
                            # Keep the raw scraped text as the ``interpretation``
                            # field so Admin can still see what the page returned
                            # (avoiding the empty-string default that would
                            # otherwise replace the row's body with the snippet).
                            interpretation = markdown or snippet_clean
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
                            total_skipped += 1
                            return
                    else:
                        brief_context = raw_content if repo_activity is not None else (markdown or normalized.snippet)

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
                                context_max_chars=(
                                    _REPO_DIGEST_CONTEXT_MAX_CHARS
                                    if repo_activity is not None
                                    else None
                                ),
                            )
                            token_in += brief.cost.token_input_total
                            token_out += brief.cost.token_output_total
                            cost_usd += _cost_usd(brief.cost)
                            if brief.status != AI_JOB_STATUS["SUCCEEDED"] or not brief.output_text:
                                raise RuntimeError(f"brief generation ended in {brief.status}")
                            interpretation = brief.output_text.strip()
                        except Exception as brief_exc:
                            if not _can_use_snippet_fallback(source, raw_candidate):
                                raise
                            fallback_count += 1
                            brief = None
                            interpretation = normalized.snippet.strip()[:2000]
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
                    if distilled_scorer is not None and brief is not None:
                        from ai_engine.scoring.scoring_profiles import profile_for_source

                        profile, _ = profile_for_source(source.source_type)
                        cleaned = _clean_content(raw_content)
                        if cleaned:
                            distilled_result = await distilled_scorer(
                                normalized.title,
                                cleaned,
                                profile=profile,
                                source_type=source.source_type,
                                url=normalized.url,
                                published_at=normalized.published_at,
                            )
                        else:
                            from ai_engine.radar.distilled_scorer import default_score
                            distilled_result = default_score(profile)
                        if distilled_result.is_default:
                            fallback_count += 1
                        if monitor is not None:
                            monitor.record(distilled_result)
                    extra_tags_list = ["pr_soft"] if filter_result.is_pr else []
                    # Distilled v2 is the sole quality gate. Skip `tier=noise`
                    # rows from entering the DB entirely (Day 4 change). A
                    # low-quality fallback never has a real LLM verdict, so it
                    # stays in the queue for human review instead of being
                    # auto-skipped as noise.
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
                        total_skipped += 1
                        skipped_distilled_noise += 1
                        return

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
    """Run sync, post-processing, enrichment, then the daily digest.

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
    if triggered_by == "cron" and RADAR_SOURCE_RETRIES > 0:
        for attempt in range(RADAR_SOURCE_RETRIES):
            retry_source_ids = {
                result.source_id
                for result in all_runs
                if _is_retryable_source_result(result)
            }
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
    try:
        from ai_engine.radar.tracked_repo_manager import (
            run_tracked_repo_postprocessing,
        )

        source_types: dict[str, str] = {}
        async with pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT "id", "sourceType" FROM "radar_sources"'
                )
            ).fetchall()
        source_types = {
            str(row["id"]): str(row["sourceType"]) for row in rows
        }
        run_id_map = {
            source_types[run.source_id]: run.run_id
            for run in sync_result.runs
            if run.source_id in source_types
        }
        tracked_repo_result = await run_tracked_repo_postprocessing(
            pool,
            run_id_map,
            fallback_to_latest=False,
        )
    except Exception as exc:
        tracked_repo_result = {}
        logger.warning(
            "ai-engine.radar.tracked_repo_stage_failed",
            extra={"error_type": type(exc).__name__},
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
        enrichment_error = None
    except Exception as exc:
        enriched_count = 0
        enrichment_error = f"{type(exc).__name__}: {str(exc)[:200]}"
        logger.warning(
            "ai-engine.radar.enrichment_stage_failed",
            extra={"error_type": type(exc).__name__},
        )
    enrichment_elapsed_ms = int((time.monotonic() - started) * 1000)
    digest_started = time.monotonic()
    try:
        from ai_engine.radar.daily_digest import generate_daily_digest

        digest_date = target_date or datetime.now(
            ZoneInfo("Asia/Shanghai")
        ).date()
        digest_result = await generate_daily_digest(pool, target_date=digest_date)
        digest_attempts = RADAR_DIGEST_RETRIES if triggered_by == "cron" else 0
        for attempt in range(digest_attempts):
            if not digest_result.narrative_degraded:
                break
            await asyncio.sleep(2.0 * (attempt + 1))
            digest_result = await generate_daily_digest(pool, target_date=digest_date)
        digest_summary_id = digest_result.summary_id
        digest_candidate_count = digest_result.candidate_count
        digest_narrative_degraded = digest_result.narrative_degraded
        digest_error = None
    except Exception as exc:
        digest_summary_id = None
        digest_candidate_count = 0
        digest_narrative_degraded = False
        digest_error = f"{type(exc).__name__}: {str(exc)[:200]}"
        logger.warning(
            "ai-engine.radar.digest_stage_failed",
            extra={"error_type": type(exc).__name__},
        )
    digest_elapsed_ms = int((time.monotonic() - digest_started) * 1000)
    return RadarPipelineResult(
        sync=sync_result,
        tracked_repo_result=tracked_repo_result,
        enriched_count=enriched_count,
        enrichment_elapsed_ms=enrichment_elapsed_ms,
        enrichment_error=enrichment_error,
        digest_summary_id=digest_summary_id,
        digest_candidate_count=digest_candidate_count,
        digest_narrative_degraded=digest_narrative_degraded,
        digest_elapsed_ms=digest_elapsed_ms,
        digest_error=digest_error,
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
