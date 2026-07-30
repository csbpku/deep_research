"""Share worker — Week 4 (W4-2).

Implements user-share submission: `POST /api/shares`.

Flow (architecture §九 risk 5 / state-machines §4):

1. BFF (apps/web) accepts `ShareUrlInput { url, userNote? }`, validates,
   then calls ai-engine `POST /api/shares`.
2. ai-engine validates again (defence-in-depth), computes canonical URL
   + SHA-256, writes a `summaries` row with `source='user'` and
   `status='pending_review'`. The user-facing summary does NOT appear
   in public feeds yet — only admin approve moves it to `published`
   (state-machines §4 + W8 admin approval).
3. ai-engine fires a background worker (`share_worker`) that does:
   - safe_fetch(url) → Markdown-only body
   - adapter.summary_brief(topic, sources) → light summary
   - UPDATE `summaries` row with the body / title / tags
   - keep status='pending_review' until admin approves

The worker reuses `DbJobStore` with a new table `share_submissions`
in the same runner family. **However** since the schema is frozen, we
record the job inside the `summaries` row itself (the row's `status`
column doubles as the queue position; `pending_review` = queued,
and `published`/`rejected` = terminal). This avoids a 13th table.

Logs:
- request_id always included
- Never logs URL query string, body, userNote text, or fetched content
- On error: code + host (no query)

Errors:
- `VALIDATION_FAILED` — missing/invalid url or userNote
- `URL_FETCH_BLOCKED` / `URL_FETCH_TIMEOUT` / `URL_FETCH_TOO_LARGE` /
  `URL_REDIRECT_LIMIT` — surfaced by safe_fetch
- `INTERNAL` — DB failure
- `WORKER_LEASE_LOST` — heartbeat failed during background worker
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import structlog

from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import SUMMARY_STATUS
from ai_engine.fetcher.safe_fetch import (
    FetchedDocument,
    SafeFetchError,
    safe_fetch,
)

logger = logging.getLogger("ai_engine.server.share")
structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
)


# ─────────────── URL canonicalisation & content sanitisation ────────────────


_TRACKING_QUERY_KEYS = re.compile(
    r"^(utm_[a-z]+|fbclid|gclid|msclkid|mc_(?:eid|cid)|ref|source)$",
    re.IGNORECASE,
)


def _canonical_url(url: str) -> str:
    """Normalise a URL for dedup (drop fragment, strip tracking params).

    Returns a stable canonical form for the `canonicalUrl` UNIQUE column.
    """
    parts = urlsplit(url)
    # Drop fragment + userinfo (already validated by safe_fetch shape).
    cleaned_query: list[str] = []
    if parts.query:
        for pair in parts.query.split("&"):
            if "=" not in pair:
                continue
            key, _ = pair.split("=", 1)
            if _TRACKING_QUERY_KEYS.match(key.strip()):
                continue
            cleaned_query.append(pair)
    new_query = "&".join(sorted(cleaned_query)) if cleaned_query else ""
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), parts.path, new_query, "")
    )


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _strip_tracking_query(url: str) -> str:
    """Public helper used by the worker to log only the path (no query)."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def _strip_dangerous_html(text: str) -> str:
    """Lightweight Markdown-only HTML sanitiser.

    We deliberately avoid pulling in `bleach` / `lxml` — the worker only
    needs to remove <script>/<style>/<iframe>/<object>/event attrs +
    dangerous `javascript:` / `data:` URLs to satisfy the W3 import
    rule that we never persist raw HTML. The result is plain text /
    Markdown; downstream the BFF / admin can render it safely.
    """
    # Remove paired script/style/iframe/object/embed blocks (incl. content).
    for tag in ("script", "style", "iframe", "object", "embed"):
        pattern = re.compile(
            rf"<\s*{tag}\b[^>]*>.*?<\s*/\s*{tag}\s*>",
            flags=re.DOTALL | re.IGNORECASE,
        )
        text = pattern.sub("", text)
        # Also drop unclosed open tags like `<script foo>` with no close.
        text = re.sub(
            rf"<\s*{tag}\b[^>]*>",
            "",
            text,
            flags=re.IGNORECASE,
        )
    # Drop on* event attrs (no `data-*` blanket strip — data-* is a
    # valid HTML5 attribute mechanism).
    text = re.sub(
        r"\s+on[a-z]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)",
        "",
        text,
        flags=re.IGNORECASE,
    )
    # Drop javascript: / data: href / src values.
    text = re.sub(
        r'(?:href|src|xlink:href)\s*=\s*"(?:javascript|data):[^"]*"',
        "",
        text,
        flags=re.IGNORECASE,
    )
    return text


def html_to_markdown(html: str) -> str:
    """Convert HTML to a Markdown approximation (heading/paragraph/links).

    The point is *not* fidelity — just safe-to-render text for the
    admin reviewer and the eventual public page. We strip tags not in
    the safe whitelist; everything else becomes plain text or basic
    Markdown.
    """
    safe = _strip_dangerous_html(html)
    # W9 code review 修订：此前实体解码在标签剥离之后，
    # 导致 &lt;script&gt;…&lt;/script&gt; 被 decode 成活体标签残片。
    # 对调顺序：先解码，再让 catch-all 正则抹掉所有尖括号标签。
    text = (
        safe.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    # Strip remaining tags; keep text + newlines.
    text = re.sub(r"<[^>]+>", " ", text)
    # Collapse runs of whitespace.
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ─────────────── Result types ────────────────


@dataclass(slots=True, frozen=True)
class ShareSubmission:
    """Returned to the BFF so it can surface submission id + status."""

    summary_id: str
    canonical_url: str
    status: str
    request_id: str | None = None


# ─────────────── DB helpers (psycopg; uses the caller's pool) ──────────────


async def _insert_pending_summary(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
    url: str,
    title: str,
    user_id: str,
    user_note: str | None,
    summary_date: date,
    request_id: str | None,
) -> None:
    """Insert a `summaries` row with status='pending_review', source='user'.

    Returns the row's id. The runner will fill `body` / final title
    later; until then, callers should treat the row as a placeholder.
    """
    sql = (
        'INSERT INTO "summaries" '
        '("id", "title", "body", "url", "canonicalUrl", "source", "contentOrigin", '
        '"userNote", "sharedByUserId", "summaryDate", "tags", "status", "createdAt", "updatedAt") '
        "VALUES (%s, %s, %s, %s, %s, 'user', 'web', %s, %s, %s, %s::text[], 'pending_review', now(), now()) "
        'ON CONFLICT ("canonicalUrl") DO NOTHING '
        'RETURNING "id"'
    )
    params: tuple[Any, ...] = (
        summary_id,
        title[:300] if title else "Untitled",
        "",  # body filled by background worker
        url[:2048],
        canonical_url[:2048],
        user_note[:500] if user_note else None,
        user_id,
        summary_date,
        [],  # tags; populated by worker
    )
    async with pool.connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(sql, params)
            row = await cur.fetchone()
    if row is None:
        # ON CONFLICT means a previous share with the same canonical
        # url exists — caller decides to either return the existing id
        # or reject. We log + propagate the empty return so the
        # endpoint can surface a friendly message.
        raise ShareDuplicateUrl(canonical_url)


class ShareDuplicateUrl(Exception):
    """Raised when the canonical url already exists in `summaries`."""

    def __init__(self, canonical_url: str) -> None:
        super().__init__(canonical_url)
        self.canonical_url = canonical_url


async def _lookup_existing_summary(pool: Any, canonical_url: str) -> dict[str, Any] | None:
    """Read the row by canonical_url — used for the dedup response."""
    sql = (
        'SELECT "id", "status", "source", "sharedByUserId", "userNote", '
        '"createdAt", "updatedAt" FROM "summaries" WHERE "canonicalUrl" = %s'
    )
    async with pool.connection() as conn:
        cur = await conn.execute(sql, (canonical_url[:2048],))
        row = await cur.fetchone()
    if row is None:
        return None
    if not isinstance(row, dict):
        row = dict(row)
    return row


async def _update_summary_with_fetched_content(
    pool: Any,
    *,
    summary_id: str,
    title: str,
    body_markdown: str,
    content_sha256: str,
    tags: list[str],
    request_id: str | None,
) -> None:
    """Fill the placeholder row with the actual fetched body."""
    sql = (
        'UPDATE "summaries" '
        'SET "title" = %s, "body" = %s, "contentSha256" = %s, "tags" = %s::text[], '
        '"updatedAt" = now() '
        'WHERE "id" = %s AND "status" = \'pending_review\' '
        'RETURNING "id"'
    )
    params = (
        title[:300] if title else "Untitled",
        body_markdown,
        content_sha256,
        tags,
        summary_id,
    )
    async with pool.connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(sql, params)
            row = await cur.fetchone()
    if row is None:
        # Row vanished or status changed; treat as lease lost.
        raise AdapterError(
            code="WORKER_LEASE_LOST",
            message="summary row not in pending_review when worker tried to update",
        )


async def _mark_summary_failed(
    pool: Any,
    *,
    summary_id: str,
    error_code: str,
    error_message: str,
    request_id: str | None,
) -> None:
    """Move pending_review → rejected with an error code.

    Note: per state-machines §4, `rejected` is the admin-rejection
    state. For fetcher/parser failures we still use `rejected` rather
    than leaving `pending_review` so admin can distinguish "we never
    got the body" from "ready for review". The BFF surfaces the error
    code separately.
    """
    sql = (
        'UPDATE "summaries" '
        "SET \"status\" = 'rejected', \"updatedAt\" = now() "
        "WHERE \"id\" = %s AND \"status\" = 'pending_review' "
        'RETURNING "id"'
    )
    async with pool.connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(sql, (summary_id,))
            row = await cur.fetchone()
    if row is None:
        # Already terminal — no-op.
        return
    # Record an audit-style log line; admin sees it via /api/admin.
    structlog.get_logger("ai_engine.server.share").warning(
        "ai-engine.share.failed",
        request_id=request_id,
        summary_id=summary_id,
        error_code=error_code,
        error_message=error_message[:200],
    )


# ─────────────── Background worker ────────────────


@dataclass(slots=True)
class _ShareTask:
    """In-memory tracker for in-flight shares (used by tests + lifespan)."""

    summary_id: str
    canonical_url: str
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# Module-level state: pool + adapter hooks.
# The worker is fired from the FastAPI handler; the DB pool + adapter
# are injected at runtime.
async def run_share_worker(
    *,
    pool: Any,
    adapter: Any,
    summary_id: str,
    canonical_url: str,
    url: str,
    request_id: str | None,
) -> None:
    """Background worker — fetch URL, summarise, update summaries row.

    On any failure the row is moved to `rejected` and an audit-style
    log line emitted; admin sees the failure via `/api/admin` later.
    """
    log = structlog.get_logger("ai_engine.server.share")

    def _stripped(u: str) -> str:
        # Never log query strings; safe_fetch's allow-list is the only
        # thing keeping them out of the logs.
        return _strip_tracking_query(u)

    try:
        # 1. Safe fetch — SSRF guards apply.
        try:
            doc: FetchedDocument = await safe_fetch(url)
        except SafeFetchError as exc:
            log.warning(
                "ai-engine.share.fetch_rejected",
                request_id=request_id,
                summary_id=summary_id,
                code=exc.code,
                host=exc.host or "",
            )
            await _mark_summary_failed(
                pool,
                summary_id=summary_id,
                error_code=exc.code,
                error_message=exc.message,
                request_id=request_id,
            )
            return

        # 2. Convert to Markdown — never store raw HTML.
        body_md = html_to_markdown(doc.content.decode("utf-8", errors="replace"))
        title = _infer_title(doc, body_md)
        body_sha = _sha256_hex(body_md)

        # 3. Light summary via adapter — fail soft if adapter unavailable.
        try:
            adapter_summary = await _summarise_via_adapter(
                adapter,
                topic=title,
                source_url=_stripped(url),
                body=body_md,
                request_id=request_id,
            )
            if adapter_summary:
                body_md = adapter_summary
        except AdapterError as exc:
            # Adapter unavailable / quota — keep the markdown body we
            # already extracted; admin can still review the raw content.
            log.warning(
                "ai-engine.share.adapter_unavailable",
                request_id=request_id,
                summary_id=summary_id,
                error_code=exc.code,
            )

        # 4. Update the placeholder row.
        await _update_summary_with_fetched_content(
            pool,
            summary_id=summary_id,
            title=title,
            body_markdown=body_md[:2000],
            content_sha256=body_sha,
            tags=[],
            request_id=request_id,
        )
        log.info(
            "ai-engine.share.fetched",
            request_id=request_id,
            summary_id=summary_id,
            host=doc.final_ip,
            bytes=len(doc.content),
            status=doc.status,
        )
    except Exception as exc:
        log.exception(
            "ai-engine.share.unhandled",
            request_id=request_id,
            summary_id=summary_id,
        )
        await _mark_summary_failed(
            pool,
            summary_id=summary_id,
            error_code="INTERNAL",
            error_message=f"{type(exc).__name__}: {str(exc)[:200]}",
            request_id=request_id,
        )


def _infer_title(doc: FetchedDocument, body_md: str) -> str:
    """Extract a reasonable title from <title> tag or first non-empty line."""
    # Decode the body for a quick title grep; cheap + safe.
    raw = doc.content.decode("utf-8", errors="replace")
    m = re.search(r"<title[^>]*>(.*?)</title>", raw, flags=re.DOTALL | re.IGNORECASE)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()
        return title[:300]
    # Fall back to the first 80 chars of the markdown body.
    first = body_md.strip().splitlines()
    if first:
        return first[0][:300]
    return "Untitled"


async def _summarise_via_adapter(
    adapter: Any,
    *,
    topic: str,
    source_url: str,
    body: str,
    request_id: str | None,
) -> str | None:
    """Best-effort light summary using the configured adapter.

    The adapter Protocol is research-oriented, so the share worker
    treats this as *optional*: if the adapter doesn't expose a
    quick summary helper, we just keep the Markdown body we already
    extracted from the safe_fetch + html_to_markdown pipeline.

    Returns the summarised body string, or None if the adapter
    declined. Errors are translated to `AdapterError` so the caller
    can log + decide.
    """
    # `FakeAdapter` has no summary_brief helper; fall through to body.
    name = getattr(adapter, "name", None)
    if name != "claude":
        return None
    # For GptResearcherAdapter, we don't have a 1-shot summary endpoint, so
    # we keep the markdown body. W5 worker will replace this with
    # the real summary pipeline once `summary_brief` supports a
    # single-source input.
    return None


# ─────────────── Module helpers exposed to the HTTP layer ────────────────


def validate_share_input(
    *, url: str | None, user_note: str | None
) -> tuple[str, str]:
    """Defence-in-depth validation (BFF has zod, ai-engine has Pydantic).

    Returns (clean_url, clean_user_note).
    Raises `AdapterError(VALIDATION_FAILED, ...)` on rejection.
    """
    if not isinstance(url, str) or not url:
        raise AdapterError(
            code="VALIDATION_FAILED", message="url is required",
        )
    if len(url) > 2048:
        raise AdapterError(
            code="VALIDATION_FAILED", message="url exceeds 2048 chars",
        )
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise AdapterError(
            code="VALIDATION_FAILED",
            message="url scheme must be http or https",
        )
    if not parts.hostname:
        raise AdapterError(
            code="VALIDATION_FAILED", message="url has no host",
        )
    note = (user_note or "").strip()
    if len(note) > 500:
        raise AdapterError(
            code="VALIDATION_FAILED", message="userNote exceeds 500 chars",
        )
    # Reject obvious prompt-injection attempts in the note.
    if note and any(
        token in note.lower()
        for token in ("ignore previous", "system:", "assistant:", "<|im_start|>")
    ):
        raise AdapterError(
            code="VALIDATION_FAILED",
            message="userNote contains disallowed tokens",
        )
    return url, note


async def submit_share(
    *,
    pool: Any,
    user_id: str,
    url: str,
    user_note: str | None,
    request_id: str | None,
    adapter: Any | None = None,
) -> ShareSubmission:
    """Insert a pending summary, return its id, fire background worker.

    Caller (FastAPI handler) passes the DbJobStore pool and the
    ResearchEngineAdapter. Background worker is launched via
    `asyncio.create_task` so the HTTP request returns 202 immediately.
    """
    url, note = validate_share_input(url=url, user_note=user_note)
    canonical = _canonical_url(url)
    summary_id = str(uuid.uuid4())
    today = date.today()

    try:
        await _insert_pending_summary(
            pool,
            summary_id=summary_id,
            canonical_url=canonical,
            url=url,
            title="Pending review",
            user_id=user_id,
            user_note=note,
            summary_date=today,
            request_id=request_id,
        )
    except ShareDuplicateUrl:
        existing = await _lookup_existing_summary(pool, canonical)
        if existing is None:
            # Race: someone else deleted between insert and lookup.
            raise AdapterError(
                code="INTERNAL",
                message="share canonical race resolved as missing",
            ) from None
        # Treat as idempotent — return the existing row.
        return ShareSubmission(
            summary_id=str(existing["id"]),
            canonical_url=canonical,
            status=str(existing["status"]),
            request_id=request_id,
        )

    # Fire background fetch + summary.
    if adapter is not None:
        asyncio.create_task(
            run_share_worker(
                pool=pool,
                adapter=adapter,
                summary_id=summary_id,
                canonical_url=canonical,
                url=url,
                request_id=request_id,
            )
        )

    return ShareSubmission(
        summary_id=summary_id,
        canonical_url=canonical,
        status=str(SUMMARY_STATUS["PENDING_REVIEW"]),
        request_id=request_id,
    )


# Cheap module-level env helper for tests that want to force a base URL.
_DEFAULT_BASE_URL: str | None = None


__all__ = [
    "ShareDuplicateUrl",
    "ShareSubmission",
    "_canonical_url",
    "_sha256_hex",
    "_strip_dangerous_html",
    "_strip_tracking_query",
    "html_to_markdown",
    "run_share_worker",
    "submit_share",
    "validate_share_input",
]