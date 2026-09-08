"""Radar deep-dive enrichment worker.

Phase 2A: enrich GitHub repo candidates with file tree + entry points +
repo metadata by calling GitHub's REST API.
Phase 2B: enrich arxiv paper candidates with HTML-first structure
(sections + figures) + LLM-generated TL;DR. PDF parsing is retained as a
fallback for papers without a usable rendered HTML page.

Design points:
- Failures are isolated per candidate; one repo's 404/timeout does not
  block the rest of the batch.
- When ``GH_TOKEN`` is unset we degrade gracefully — skip the tree call,
  log a warning, and let the next sync attempt retry (no crash).
- We never call ``safe_fetch`` against api.github.com: HTTPS+443 + JSON
  content-type is already in the allow-list; using httpx directly keeps
  the failure modes easy to read.
- arXiv HTML is fetched from ar5iv/arXiv first. This preserves paragraph,
  section, link, table, and math boundaries. PDF parsing is a fallback only;
  its text extraction is inherently lossy for multi-column papers.
- Repository metadata stays bounded for inline delivery; Zread pages are
  retained as the complete generated document and may use Postgres TOAST.
"""

from __future__ import annotations

import asyncio
import json
import hashlib
import logging
import os
import re as _re
import re as _re_arxiv
import socket
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

import httpx

from ai_engine.fetcher.safe_fetch import safe_fetch
from ai_engine.llm.client import generate_text
from ai_engine.llm.config import resolve_spec
from ai_engine.radar.distilled_scorer import _parse_llm_response
from ai_engine.radar.enrichment_contract import enrichment_review_reset_assignments
from ai_engine.radar.reader_quality import evaluate_reader_quality
from ai_engine.radar.review_reconciliation import finalize_enrichment

logger = logging.getLogger("ai_engine.radar.enrichment_worker")

# A sync run and a detail-page retry may share the same process and database.
# The process-local lock below protects the common in-process case.  The
# PostgreSQL advisory lock in ``_cross_process_enrichment_lock`` protects the
# more important case where a manual script and uvicorn run in different
# processes.
_ENRICHMENT_RUN_LOCK = asyncio.Lock()
_ENRICHMENT_ADVISORY_LOCK_KEYS = (2147483629, 20260827)
ENRICHMENT_WORKER_ID = (
    f"enrichment-{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:10]}"
)


def _env_int(name: str, default: int, *, minimum: int) -> int:
    """Parse worker tuning knobs without allowing one bad env to kill import."""
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


ENRICHMENT_LEASE_SECONDS = _env_int(
    "RADAR_ENRICHMENT_LEASE_SECONDS",
    900,
    minimum=300,
)
ENRICHMENT_HEARTBEAT_SECONDS = max(
    15,
    min(
        _env_int(
            "RADAR_ENRICHMENT_HEARTBEAT_SECONDS",
            60,
            minimum=15,
        ),
        ENRICHMENT_LEASE_SECONDS // 3,
    ),
)
ENRICHMENT_MAX_ATTEMPTS = _env_int(
    "RADAR_ENRICHMENT_MAX_ATTEMPTS",
    6,
    minimum=1,
)
ENRICHMENT_RETRY_BASE_SECONDS = _env_int(
    "RADAR_ENRICHMENT_RETRY_BASE_SECONDS",
    300,
    minimum=30,
)
ENRICHMENT_RETRY_MAX_SECONDS = max(
    ENRICHMENT_RETRY_BASE_SECONDS,
    _env_int(
        "RADAR_ENRICHMENT_RETRY_MAX_SECONDS",
        21600,
        minimum=30,
    ),
)
_RETURNING_ID = ' RETURNING "id"'


class EnrichmentLeaseLost(RuntimeError):
    """Raised when a late worker no longer owns the summary lease."""


def _lease_guard(
    lease_owner: str | None,
    claim_id: str | None = None,
) -> str:
    if not lease_owner:
        return ""
    guard = (
        ' AND "enrichmentStatus" = \'running\' '
        'AND "enrichmentLockedBy" = %s'
    )
    if claim_id:
        guard += ' AND "enrichmentClaimId" = %s::uuid'
    return guard


def _lease_params(
    lease_owner: str | None,
    claim_id: str | None = None,
) -> tuple[str, ...]:
    if not lease_owner:
        return ()
    return (lease_owner, claim_id) if claim_id else (lease_owner,)


async def _assert_enrichment_lease(
    pool: Any,
    *,
    summary_id: str,
    lease_owner: str,
    claim_id: str,
) -> None:
    """Fail before post-source work if this attempt no longer owns the row."""
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT 1 FROM "summaries" '
                'WHERE "id" = %s '
                'AND "enrichmentStatus" = \'running\' '
                'AND "enrichmentLockedBy" = %s '
                'AND "enrichmentClaimId" = %s::uuid',
                (summary_id, lease_owner, claim_id),
            )
        ).fetchone()
    if row is None:
        raise EnrichmentLeaseLost(summary_id)


async def release_enrichment_leases(
    pool: Any,
    *,
    lease_owner: str = ENRICHMENT_WORKER_ID,
) -> int:
    """Return this process's in-flight rows to the durable retry queue.

    This is used during graceful shutdown/reload. A crash still relies on the
    lease expiry, while a normal shutdown should not leave rows blocked for
    the full lease duration.
    """
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'UPDATE "summaries" SET '
                '"enrichmentStatus" = \'retryable\', '
                '"enrichmentLockedBy" = NULL, '
                '"enrichmentLeaseExpiresAt" = NULL, '
                '"enrichmentHeartbeatAt" = NULL, '
                '"enrichmentClaimId" = NULL, '
                '"enrichmentNextRetryAt" = now(), '
                '"enrichmentErrorCode" = \'WORKER_SHUTDOWN\', '
                '"enrichmentErrorMessage" = \'worker stopped before enrichment completed\', '
                '"updatedAt" = now() '
                'WHERE "enrichmentStatus" = \'running\' '
                'AND "enrichmentLockedBy" = %s '
                'RETURNING "id"',
                (lease_owner,),
            )
        ).fetchall()
    return len(rows)


async def recover_expired_enrichment_leases(
    pool: Any,
    *,
    limit: int = 50,
) -> int:
    """Make crashed enrichment attempts visible before the next claim.

    Claiming an expired row directly is safe, but it hides the fact that the
    previous attempt died. Persisting the recovery event first gives
    operators a durable ``WORKER_LOST`` breadcrumb and makes a stopped worker
    observable without waiting for a later source write.
    """
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'WITH expired AS ('
                'SELECT "id" FROM "summaries" '
                'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND "enrichmentStatus" = \'running\' '
                'AND "enrichmentLeaseExpiresAt" < now() '
                'ORDER BY "enrichmentLeaseExpiresAt" ASC '
                'LIMIT %s FOR UPDATE SKIP LOCKED'
                ') '
                'UPDATE "summaries" AS s SET '
                '"enrichmentStatus" = \'retryable\', '
                '"enrichmentLockedBy" = NULL, '
                '"enrichmentLeaseExpiresAt" = NULL, '
                '"enrichmentHeartbeatAt" = NULL, '
                '"enrichmentClaimId" = NULL, '
                '"enrichmentNextRetryAt" = now(), '
                '"enrichmentErrorCode" = \'WORKER_LOST\', '
                '"enrichmentErrorMessage" = \'previous enrichment lease expired\', '
                '"updatedAt" = now() '
                'FROM expired WHERE s."id" = expired."id" '
                'RETURNING s."id"',
                (max(1, limit),),
            )
        ).fetchall()
    if rows:
        logger.warning(
            "ai-engine.radar.enrichment.expired_leases_recovered",
            extra={"count": len(rows)},
        )
    return len(rows)


# Cap tree nodes to keep payloads bounded; 200 is the gpt-researcher
# recommendation and matches Phase 2A design.
TREE_NODE_MAX = 200
# Cap JSONB payload to ~16KB (well under Postgres TOAST).
ORIGINAL_META_MAX_BYTES = 16_000
README_MAX_CHARS = 120_000
# Inline SVG figures are base64-encoded for the safe Markdown renderer. Keep
# a bounded 2MB payload for HTML/PDF enrichment; GitHub Zread pages are already
# bounded by their provider adapters and must not be silently clipped again.
ARXIV_MARKDOWN_MAX_BYTES = 2 * 1024 * 1024
ENRICHMENT_VERSION = "2.0"
GITHUB_ENRICHMENT_RETRY_SECONDS = _env_int(
    "RADAR_GITHUB_ENRICHMENT_RETRY_SECONDS",
    7200,
    minimum=3_600,
)
WEB_ENRICHMENT_RETRY_SECONDS = _env_int(
    "RADAR_WEB_ENRICHMENT_RETRY_SECONDS",
    3600,
    minimum=900,
)

# Files we mark as "key" in the file tree renderer.
_KEY_FILES = frozenset({
    "readme.md", "readme.rst", "readme.txt", "readme",
    "license", "license.md", "license.txt",
    "pyproject.toml", "setup.py", "setup.cfg",
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "cargo.toml", "cargo.lock",
    "go.mod", "go.sum",
    "makefile",
    "dockerfile", "docker-compose.yml", "docker-compose.yaml",
    "tsconfig.json", "jsconfig.json",
    ".gitignore", ".editorconfig",
})

# Heuristic for entry points: files in src/ at any depth, or top-level
# files matching common entry patterns.
_ENTRY_POINT_TOP_LEVEL = (
    "main.py", "app.py", "__main__.py", "cli.py", "server.py",
    "main.go", "main.rs", "main.js", "main.ts", "main.tsx",
    "index.js", "index.ts", "index.tsx", "index.html",
    "app.js", "app.ts", "app.tsx",
    "server.js", "server.ts",
)
_GITHUB_API = "https://api.github.com"
_GITHUB_REPO_PATH_RE = _re.compile(
    r"^/([^/]+)/([^/]+)/?$"
)
_GITHUB_ISSUE_PATH_RE = _re.compile(r"^/([^/]+)/([^/]+)/issues/(\d+)/?$")
_GITHUB_PR_PATH_RE = _re.compile(r"^/([^/]+)/([^/]+)/pull/(\d+)/?$")
_GITHUB_RELEASE_PATH_RE = _re.compile(
    r"^/([^/]+)/([^/]+)/releases/tag/([^/]+)/?$"
)

# All originalKind values that the deep-dive worker can enrich. GitHub issue /
# PR / release pages are fetched through the REST API (the HTML page is mostly
# JS navigation noise), everything else goes through safe_fetch + markdown.
DEFAULT_ENRICHMENT_KINDS: tuple[str, ...] = (
    "github_repo",
    "arxiv",
    "github_other",
    "github_issue",
    "github_pr",
    "github_release",
    "rss",
    "web_share",
)


def _parse_github_item_url(url: str) -> tuple[str, str, str, str] | None:
    """Extract (owner, repo, number_or_tag, kind) from a GitHub item URL."""
    try:
        u = urlsplit((url or "").strip())
    except Exception:
        return None
    if u.netloc.lower() not in ("github.com", "www.github.com"):
        return None
    path = u.path
    m = _GITHUB_ISSUE_PATH_RE.match(path)
    if m:
        return m.group(1), m.group(2), m.group(3), "issue"
    m = _GITHUB_PR_PATH_RE.match(path)
    if m:
        return m.group(1), m.group(2), m.group(3), "pr"
    m = _GITHUB_RELEASE_PATH_RE.match(path)
    if m:
        return m.group(1), m.group(2), unquote(m.group(3)), "release"
    return None


async def _fetch_github_item(
    client: httpx.AsyncClient,
    owner: str,
    repo: str,
    number_or_tag: str,
    kind: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Fetch one GitHub issue/PR/release plus its comments (issues/PRs only)."""
    headers = _github_headers(os.environ.get("GH_TOKEN"))
    if kind in ("issue", "pr"):
        base = f"{_GITHUB_API}/repos/{owner}/{repo}/issues/{number_or_tag}"
        item_resp = await client.get(base, headers=headers, timeout=10.0)
        item_resp.raise_for_status()
        item: dict[str, Any] = item_resp.json()
        comments: list[dict[str, Any]] = []
        comments_resp = await client.get(
            f"{base}/comments",
            params={"per_page": "10"},
            headers=headers,
            timeout=10.0,
        )
        if comments_resp.status_code == 200:
            raw_comments = comments_resp.json()
            comments = [
                c for c in raw_comments if isinstance(c, dict)
            ][:10]
        return item, comments

    base = f"{_GITHUB_API}/repos/{owner}/{repo}/releases/tags/{quote(number_or_tag, safe='')}"
    item_resp = await client.get(base, headers=headers, timeout=10.0)
    item_resp.raise_for_status()
    item = item_resp.json()
    return item, []


def _github_item_markdown(
    item: dict[str, Any],
    *,
    kind: str,
    comments: list[dict[str, Any]],
) -> str:
    """Build a readable markdown snapshot for an issue/PR/release."""
    title = str(item.get("title") or item.get("name") or "(no title)")
    body = str(item.get("body") or "").strip()
    parts: list[str] = [f"# {title[:300]}"]
    state = item.get("state")
    if state:
        parts.append(f"**状态**: {state}")
    labels = [
        str(label.get("name"))
        for label in item.get("labels", [])
        if isinstance(label, dict) and label.get("name")
    ]
    if labels:
        parts.append(f"**标签**: {', '.join(labels[:12])}")
    if kind == "release":
        tag = item.get("tag_name")
        if tag:
            parts.append(f"**Tag**: {tag}")
        assets = item.get("assets") or []
        if isinstance(assets, list) and assets:
            parts.append(f"**Assets**: {len(assets)}")
    if body:
        parts.append("\n\n" + body)
    for i, comment in enumerate(comments, 1):
        author = ""
        user = comment.get("user")
        if isinstance(user, dict):
            author = str(user.get("login") or "")
        comment_body = str(comment.get("body") or "").strip()
        if comment_body:
            parts.append(f"\n\n### Comment {i} ({author or 'unknown'})\n\n{comment_body}")
    markdown = "\n".join(parts)
    if len(markdown.encode("utf-8")) > 65_536:
        markdown = markdown.encode("utf-8")[:65_536].decode("utf-8", errors="replace")
    return markdown


def _github_item_meta(
    item: dict[str, Any],
    *,
    owner: str,
    repo: str,
    number_or_tag: str,
    kind: str,
    comments: list[dict[str, Any]],
) -> dict[str, Any]:
    """Small structured metadata payload for GitHub item enrichment."""
    user = item.get("user")
    body = str(item.get("body") or "").strip()
    labels = [
        str(label.get("name"))
        for label in item.get("labels", [])
        if isinstance(label, dict) and label.get("name")
    ]
    comment_previews: list[dict[str, str]] = []
    for comment in comments:
        comment_body = str(comment.get("body") or "").strip()
        if not comment_body:
            continue
        comment_user = comment.get("user")
        comment_previews.append({
            "author": (
                str(comment_user.get("login") or "")
                if isinstance(comment_user, dict)
                else ""
            ),
            "body": comment_body[:500],
            "createdAt": str(comment.get("created_at") or ""),
        })
        if len(comment_previews) == 3:
            break
    payload: dict[str, Any] = {
        "provider": "github_item",
        "enrichmentVersion": ENRICHMENT_VERSION,
        "kind": kind,
        "owner": owner,
        "repo": repo,
        "numberOrTag": number_or_tag,
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "state": item.get("state"),
        "labels": labels[:20],
        "comments": (
            item.get("comments")
            if isinstance(item.get("comments"), int)
            else len(comments)
        ),
        "author": str(user.get("login") or "") if isinstance(user, dict) else "",
        "createdAt": item.get("created_at"),
        "updatedAt": item.get("updated_at"),
        "bodyPreview": body[:2_000],
        "commentPreviews": comment_previews,
    }
    for key in ("closed_at", "published_at", "tag_name", "draft", "locked"):
        if item.get(key) is not None:
            payload[key] = item.get(key)
    if kind == "release":
        assets = item.get("assets") or []
        payload["assetCount"] = len(assets) if isinstance(assets, list) else 0
    return payload


async def _fetch_enrichment_row(pool: Any, summary_id: str) -> dict[str, Any]:
    """Read the subset of a summary row needed by enrichment workers."""
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id", "title", "interpretation", "originalMarkdown", '
                '"originalMeta", "originalKind", "readerQualityStatus", '
                '"tldr", "highlights", "repoSummary" '
                'FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
    if row is None:
        return {}
    try:
        return dict(row)
    except (TypeError, ValueError):
        keys = (
            "id", "title", "interpretation",
            "originalMarkdown", "originalMeta", "originalKind",
            "readerQualityStatus", "tldr", "highlights",
            "repoSummary",
        )
        return dict(zip(keys, row))


async def _downgrade_empty_web_candidate(
    pool: Any,
    summary_id: str,
    *,
    lease_owner: str | None = None,
    claim_id: str | None = None,
) -> None:
    """Keep an unextractable page as a summary-only skim candidate.

    A deep-read tier is a claim that the source body was available.  If both
    the cached and freshly fetched markdown are empty or bot shells, retaining
    ``deep_read`` makes the UI promise content it cannot render and causes the
    scheduler to retry the same impossible work forever.  Preserve the
    interpretation, mark the row pending for admin diagnostics, and make the
    public contract honest: skim exposes the summary only.
    """
    from ai_engine.radar.sync_runner import _is_low_quality_content

    current = await _fetch_enrichment_row(pool, summary_id)
    markdown = _strip_nul(str(current.get("originalMarkdown") or ""))
    if markdown.strip() and not _is_low_quality_content(markdown):
        return
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"distilledTier" = \'skim\', '
            ''
            '"tags" = CASE WHEN \'content_pending\' = ANY('
            'COALESCE("tags", ARRAY[]::text[])) THEN "tags" '
            'ELSE array_append(COALESCE("tags", ARRAY[]::text[]), '
            '\'content_pending\') END, '
            '"updatedAt" = now() WHERE "id" = %s'
            f'{_lease_guard(lease_owner, claim_id)}'
            f'{_RETURNING_ID if lease_owner else ""}',
            (summary_id, *_lease_params(lease_owner, claim_id)),
        )
        if lease_owner and await cursor.fetchone() is None:
            raise EnrichmentLeaseLost(summary_id)


def _retry_delay_seconds(attempts: int) -> int:
    """Return bounded exponential backoff for a persisted enrichment attempt."""
    exponent = max(0, min(attempts - 1, 10))
    return int(min(
        ENRICHMENT_RETRY_MAX_SECONDS,
        ENRICHMENT_RETRY_BASE_SECONDS * (2 ** exponent),
    ))


async def request_enrichment_run(
    pool: Any,
    *,
    summary_ids: tuple[str, ...],
    force: bool = True,
) -> tuple[str, list[str]]:
    """Persist a manual enrichment request before launching any coroutine.

    The returned run id is written to every row that was queued. Rows with a
    healthy active lease are left alone, so a repeated browser click cannot
    reset work already in progress.
    """
    run_id = str(uuid.uuid4())
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'UPDATE "summaries" SET '
                '"enrichmentStatus" = \'pending\', '
                '"enrichmentRequestedAt" = now(), '
                '"enrichmentRunId" = %s::uuid, '
                '"enrichmentNextRetryAt" = now(), '
                '"enrichmentLockedBy" = NULL, '
                '"enrichmentLeaseExpiresAt" = NULL, '
                '"enrichmentHeartbeatAt" = NULL, '
                '"enrichmentClaimId" = NULL, '
                '"enrichmentErrorCode" = NULL, '
                '"enrichmentErrorMessage" = NULL, '
                '"updatedAt" = now() '
                'WHERE "id" = ANY(%s::uuid[]) '
                'AND ('
                '"enrichmentStatus" IS DISTINCT FROM \'running\' '
                'OR "enrichmentLeaseExpiresAt" < now() '
                'OR "enrichmentLeaseExpiresAt" IS NULL'
                ') '
                'AND (%s OR "enrichmentStatus" IS NULL '
                'OR "enrichmentStatus" IN (\'pending\', \'retryable\', \'manual\')) '
                'RETURNING "id"',
                (run_id, list(summary_ids), force),
            )
        ).fetchall()
    queued_ids = [
        str(row["id"]) if isinstance(row, dict) else str(row[0])
        for row in rows
    ]
    return run_id, queued_ids


async def enrich_github_item_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
    lease_owner: str | None = None,
    claim_id: str | None = None,
) -> dict[str, Any] | None:
    """Enrich a GitHub issue/PR/release candidate with REST API content."""
    parsed = _parse_github_item_url(canonical_url)
    if parsed is None:
        return None
    owner, repo, number_or_tag, kind = parsed

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            item, comments = await _fetch_github_item(
                client, owner, repo, number_or_tag, kind,
            )
    except Exception as exc:
        logger.warning(
            "ai-engine.radar.enrichment.github_item_fetch_failed",
            extra={
                "summary_id": summary_id,
                "owner": owner,
                "repo": repo,
                "kind": kind,
                "error": type(exc).__name__,
            },
        )
        return None

    markdown = _github_item_markdown(item, kind=kind, comments=comments)
    payload = _github_item_meta(
        item, owner=owner, repo=repo, number_or_tag=number_or_tag,
        kind=kind, comments=comments,
    )
    payload = _trim_to_budget(payload)
    current = await _fetch_enrichment_row(pool, summary_id)
    tldr = current.get("tldr") or current.get("interpretation")

    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMarkdown" = %s, '
            '"originalSha256" = %s, '
            '"originalMeta" = %s::jsonb, '
            '"originalBytes" = %s, '
            '"tldr" = COALESCE("tldr", %s), '
            f'{enrichment_review_reset_assignments()}, '
            '"updatedAt" = now() '
            'WHERE "id" = %s'
            f'{_lease_guard(lease_owner, claim_id)}'
            f'{_RETURNING_ID if lease_owner else ""}',
            (
                markdown,
                hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
                json.dumps(payload, ensure_ascii=False),
                len(markdown.encode("utf-8")),
                str(tldr)[:500] if tldr else None,
                summary_id,
                *_lease_params(lease_owner, claim_id),
            ),
        )
        if lease_owner and await cursor.fetchone() is None:
            raise EnrichmentLeaseLost(summary_id)
    logger.info(
        "ai-engine.radar.enrichment.github_item_done",
        extra={
            "summary_id": summary_id,
            "owner": owner,
            "repo": repo,
            "kind": kind,
            "markdown_bytes": len(markdown.encode("utf-8")),
        },
    )
    return payload


def _parse_huggingface_model_url(url: str) -> tuple[str, str] | None:
    """Extract an owner/model pair from a Hugging Face model page."""
    try:
        parsed = urlsplit(url.strip())
    except Exception:
        return None
    if parsed.netloc.lower() not in {"huggingface.co", "www.huggingface.co"}:
        return None
    parts = [unquote(part).strip() for part in parsed.path.split("/") if part.strip()]
    if len(parts) != 2 or any(part in {".", ".."} for part in parts):
        return None
    return parts[0], parts[1]


async def _fetch_huggingface_model_readme(
    canonical_url: str,
) -> Any | None:
    """Fetch a commit-pinned Hugging Face model card as plain Markdown.

    Hugging Face model pages render their useful card body through a client
    application. The generic HTML extractor can therefore see only a
    collection/source card. The public model API exposes the immutable repo
    SHA, which lets us fetch the actual README without scraping UI markup.
    """
    parsed = _parse_huggingface_model_url(canonical_url)
    if parsed is None:
        return None
    owner, model = parsed
    api_url = (
        "https://huggingface.co/api/models/"
        f"{quote(owner, safe='')}/{quote(model, safe='')}"
    )
    try:
        api_doc = await safe_fetch(api_url, timeout=15.0)
        if api_doc.status != 200:
            return None
        metadata = json.loads(api_doc.content.decode("utf-8", errors="replace"))
        sha = str(metadata.get("sha") or "").strip()
        if not sha:
            return None
        readme_url = (
            f"https://huggingface.co/{quote(owner, safe='')}/"
            f"{quote(model, safe='')}/resolve/{quote(sha, safe='')}/README.md"
        )
        readme_doc = await safe_fetch(readme_url, timeout=15.0)
        if readme_doc.status != 200 or not readme_doc.content.strip():
            return None
        return readme_doc
    except Exception:
        return None


async def enrich_web_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
    force: bool = False,
    lease_owner: str | None = None,
    claim_id: str | None = None,
) -> dict[str, Any] | None:
    """Enrich rss/web_share candidates with fresh page metadata + markdown.

    The sync pass already persists ``originalMarkdown`` for these kinds, so
    this is primarily additive: fill ``originalMeta`` and reuse the existing
    interpretation as ``tldr``. The stored markdown is only replaced when the
    current copy is missing / low quality and the new fetch is clearly clean.
    """
    from ai_engine.radar.sync_runner import (
        _extract_article_content,
        _is_low_quality_content,
    )
    from ai_engine.markdown_pipeline import inspect_markdown, markdown_sha256

    current = await _fetch_enrichment_row(pool, summary_id)
    if not current:
        return None
    existing_markdown = _strip_nul(str(current.get("originalMarkdown") or ""))
    existing_meta = current.get("originalMeta")
    if not force and (
        isinstance(existing_meta, dict)
        and existing_meta.get("provider") == "web"
        and isinstance(current.get("highlights"), dict)
        and current.get("readerQualityStatus") == "ready"
    ):
        return dict(existing_meta)

    fetched_markdown = ""
    doc = await _fetch_huggingface_model_readme(canonical_url)
    if doc is not None:
        fetched_markdown = _strip_nul(
            doc.content.decode("utf-8", errors="replace")
        )
    else:
        try:
            doc = await safe_fetch(canonical_url, timeout=15.0)
        except Exception:
            if not existing_markdown or _is_low_quality_content(existing_markdown):
                return None
    if doc is not None and not fetched_markdown:
        html = doc.content.decode("utf-8", errors="replace")
        fetched_markdown = _strip_nul(
            _extract_article_content(html, canonical_url, "web")
        )
        fetched_markdown = fetched_markdown[:ARXIV_MARKDOWN_MAX_BYTES]

    new_markdown = existing_markdown
    fetched_quality = (
        evaluate_reader_quality(
            kind=str(current.get("originalKind") or ""),
            markdown=fetched_markdown,
            original_meta=existing_meta,
        )
        if fetched_markdown
        else None
    )
    if (
        fetched_markdown
        and not _is_low_quality_content(fetched_markdown)
        and (
            not existing_markdown.strip()
            or _is_low_quality_content(existing_markdown)
            or (
                current.get("readerQualityStatus") in {"incomplete", "invalid"}
                and fetched_quality is not None
                and fetched_quality.ready
            )
        )
    ):
        new_markdown = fetched_markdown

    # A successful HTTP response is not the same as usable article content.
    # Do not persist an enrichmentVersion marker for an empty page shell: that
    # would make the scheduler believe enrichment is complete forever.
    if not new_markdown.strip() or _is_low_quality_content(new_markdown):
        logger.warning(
            "ai-engine.radar.enrichment.web_content_unusable",
            extra={
                "summary_id": summary_id,
                "url": canonical_url,
                "had_existing_markdown": bool(existing_markdown.strip()),
                "fetched": doc is not None,
            },
        )
        return None

    payload: dict[str, Any] = {
        "provider": "web",
        "enrichmentVersion": ENRICHMENT_VERSION,
        "extractorVersion": "structured-dom-markdown-v2",
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "finalUrl": doc.url if doc is not None else canonical_url,
        "finalIp": doc.final_ip if doc is not None else None,
        "status": doc.status if doc is not None else None,
        "contentType": doc.content_type if doc is not None else None,
        "title": str(current.get("title") or "")[:300],
    }
    quality = inspect_markdown(new_markdown)
    payload.update({
        "contentHash": markdown_sha256(new_markdown) if new_markdown else None,
        "quality": quality.quality,
        "warnings": list(quality.warnings),
        "paragraphCount": quality.paragraph_count,
        "headingCount": quality.heading_count,
        "linkCount": quality.link_count,
    })
    if doc is None:
        payload.update({"degraded": True, "reason": "cached_source"})
    payload = _trim_to_budget(payload)

    tldr = str(current.get("tldr") or current.get("interpretation") or "")[:500]
    # Generate highlights from the clean markdown
    highlights = None
    if new_markdown and not _is_low_quality_content(new_markdown):
        highlights = await _generate_web_highlights(new_markdown, str(current.get("title") or ""))

    markdown_bytes = new_markdown.encode("utf-8") if new_markdown else b""
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMeta" = %s::jsonb, '
            '"originalMarkdown" = %s, '
            '"originalSha256" = %s, '
            '"originalBytes" = %s, '
            '"originalFetchedAt" = now(), '
            '"tldr" = COALESCE("tldr", %s), '
            '"highlights" = %s::jsonb, '
            f'{enrichment_review_reset_assignments()}, '
            '"updatedAt" = now() '
            'WHERE "id" = %s'
            f'{_lease_guard(lease_owner, claim_id)}'
            f'{_RETURNING_ID if lease_owner else ""}',
            (
                json.dumps(payload, ensure_ascii=False),
                new_markdown or None,
                (
                    hashlib.sha256(markdown_bytes).hexdigest()
                    if markdown_bytes else None
                ),
                len(markdown_bytes) or None,
                tldr or None,
                json.dumps(highlights, ensure_ascii=False) if highlights else None,
                summary_id,
                *_lease_params(lease_owner, claim_id),
            ),
        )
        if lease_owner and await cursor.fetchone() is None:
            raise EnrichmentLeaseLost(summary_id)
    logger.info(
        "ai-engine.radar.enrichment.web_done",
        extra={
            "summary_id": summary_id,
            "status": doc.status if doc is not None else None,
            "markdown_bytes": len(markdown_bytes),
            "tldr": bool(tldr),
        },
    )
    return payload


def _strip_nul(value: str) -> str:
    """Remove NUL (0x00) bytes from a string.

    pymupdf extracts can contain stray NUL bytes from PDF font tables;
    Postgres text columns reject 0x00 with ``psycopg.DataError``. We
    scrub here rather than in the DB layer so the same string also
    lands cleanly in the LLM prompt.
    """
    return value.replace("\x00", "")


_ZREAD_UNICODE_ESCAPE = _re.compile(r"\\+u([0-9a-fA-F]{4})")


def _decode_zread_text(value: str) -> str:
    """Decode nested literal unicode escapes in Zread text before storage."""
    decoded = value
    for _ in range(3):
        repaired = _ZREAD_UNICODE_ESCAPE.sub(
            lambda match: chr(int(match.group(1), 16)),
            decoded,
        )
        if repaired == decoded:
            break
        decoded = repaired
    return _strip_nul(decoded)


def _scrub_zread_payload(obj: Any) -> Any:
    """Normalize all string leaves in a Zread payload before persistence."""
    if isinstance(obj, str):
        return _decode_zread_text(obj)
    if isinstance(obj, dict):
        return {key: _scrub_zread_payload(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [_scrub_zread_payload(value) for value in obj]
    return obj


def _scrub_dict_strings(obj: Any) -> Any:
    """Recursively scrub NUL bytes from string leaves inside a dict/list
    tree (used for ``sections`` payloads).
    """
    if isinstance(obj, str):
        return _strip_nul(obj)
    if isinstance(obj, dict):
        return {k: _scrub_dict_strings(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub_dict_strings(v) for v in obj]
    return obj


def _parse_repo_path(url: str) -> tuple[str, str] | None:
    """Extract (owner, repo) from a github.com repo URL.

    Returns None for non-repo URLs (e.g. issues, releases, PRs).
    """
    try:
        u = urlsplit(url.strip())
    except Exception:
        return None
    if u.netloc.lower() not in ("github.com", "www.github.com"):
        return None
    m = _GITHUB_REPO_PATH_RE.match(u.path)
    if not m:
        return None
    return m.group(1), m.group(2)


def _is_repo_activity_digest_url(url: str) -> bool:
    """Return True for tracked-repo daily digest pseudo-pages."""
    try:
        return bool(parse_qs(urlsplit(url.strip()).query).get("digest"))
    except (AttributeError, ValueError):
        return False


def _github_headers(token: str | None) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "deep-research-radar-enrichment/1.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def _fetch_repo_meta(
    client: httpx.AsyncClient, owner: str, repo: str
) -> dict[str, Any] | None:
    """Fetch repo metadata: default_branch, language, stars, last_push."""
    try:
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}",
            headers=_github_headers(os.environ.get("GH_TOKEN")),
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "ai-engine.radar.enrichment.github_meta_failed",
            extra={"owner": owner, "repo": repo, "error": type(exc).__name__},
        )
        return None
    if resp.status_code != 200:
        logger.warning(
            "ai-engine.radar.enrichment.github_meta_non_200",
            extra={
                "owner": owner, "repo": repo,
                "status": resp.status_code,
            },
        )
        return None
    data = resp.json()
    return {
        "defaultBranch": data.get("default_branch"),
        "language": data.get("language"),
        "stars": data.get("stargazers_count"),
        "forks": data.get("forks_count"),
        "openIssues": data.get("open_issues_count"),
        "lastPushedAt": data.get("pushed_at"),
        "description": data.get("description"),
        "snapshotFetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


async def _fetch_repo_head_sha(
    client: httpx.AsyncClient, owner: str, repo: str, branch: str,
) -> str | None:
    """Fetch the branch head so Zread generation can be cached by commit."""
    try:
        resp = await client.get(
            f"{_GITHUB_API}/repos/{owner}/{repo}/commits/{quote(branch, safe='')}",
            headers=_github_headers(os.environ.get("GH_TOKEN")),
            timeout=10.0,
        )
        if resp.status_code != 200:
            return None
        value = resp.json().get("sha")
        return str(value) if value else None
    except (httpx.HTTPError, ValueError, TypeError):
        return None


async def _fetch_repo_tree(
    client: httpx.AsyncClient, owner: str, repo: str, default_branch: str
) -> list[dict[str, Any]]:
    """Fetch 2-level deep tree; cap at TREE_NODE_MAX nodes."""
    try:
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}/git/trees/{default_branch}",
            params={"recursive": "0"},
            headers=_github_headers(os.environ.get("GH_TOKEN")),
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "ai-engine.radar.enrichment.github_tree_failed",
            extra={"owner": owner, "repo": repo, "error": type(exc).__name__},
        )
        return []
    if resp.status_code != 200:
        logger.warning(
            "ai-engine.radar.enrichment.github_tree_non_200",
            extra={"owner": owner, "repo": repo, "status": resp.status_code},
        )
        return []
    body = resp.json()
    if body.get("truncated"):
        # recursive=0 should not truncate at depth 0; flag for ops.
        logger.info(
            "ai-engine.radar.enrichment.github_tree_truncated",
            extra={"owner": owner, "repo": repo, "tree_count": len(body.get("tree", []))},
        )
    nodes = body.get("tree", [])[:TREE_NODE_MAX]
    return [
        {"path": n["path"], "type": n["type"], "size": n.get("size")}
        for n in nodes
        if n.get("path")
    ]


async def _fetch_repo_readme(
    client: httpx.AsyncClient, owner: str, repo: str, default_branch: str
) -> str | None:
    """Fetch README markdown (best-effort, returns None on any failure).

    Reads `https://api.github.com/repos/{owner}/{repo}/readme` which returns
    base64-encoded Markdown. Preserve the full README up to an explicit
    high ceiling for the reader fallback; prompt construction applies its
    own provider-safe budget separately.
    """
    try:
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}/readme",
            headers=_github_headers(os.environ.get("GH_TOKEN")),
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "ai-engine.radar.enrichment.github_readme_failed",
            extra={"owner": owner, "repo": repo, "error": type(exc).__name__},
        )
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
        content_b64 = data.get("content", "")
        import base64 as _b64
        decoded = _b64.b64decode(content_b64).decode("utf-8", errors="replace")
        return decoded[:README_MAX_CHARS]
    except Exception as exc:
        logger.warning(
            "ai-engine.radar.enrichment.github_readme_decode_failed",
            extra={"owner": owner, "repo": repo, "error": type(exc).__name__},
        )
        return None


async def _fetch_key_files(
    client: httpx.AsyncClient,
    owner: str,
    repo: str,
    default_branch: str,
    entry_points: list[str],
    tree: list[dict[str, Any]],
    *,
    max_files: int = 10,
    max_total_bytes: int = 24_000,
) -> dict[str, str]:
    """Fetch raw content of key source files so the LLM can read real code,
    not just guess from paths.

    Inspired by AIDotNet/OpenDeepWiki's `GitTool` (their agent uses
    `cat`-equivalent tools to read entry points before generating catalog).
    We do a non-agent single-shot version: pick up to `max_files` files
    combining entry_points + the largest source files under src/, fetch
    each via GitHub raw API, and return path -> content. Returns {} on
    any failure (best-effort).

    Per-file size cap 6 KB; total size cap `max_total_bytes`. The LLM
    sees the real class/function names which is what makes module
    grouping actually accurate (vs. grouping by directory name).
    """
    # Build priority list: entry points first, then largest files under src/.
    seen: set[str] = set()
    paths: list[str] = []
    for ep in entry_points:
        if ep and ep not in seen:
            seen.add(ep)
            paths.append(ep)
    for node in sorted(tree, key=lambda n: -(n.get("size") or 0)):
        p = node.get("path", "")
        if not p or p in seen:
            continue
        if node.get("type") != "blob":
            continue
        # Restrict to source dirs (skip docs/tests/vendored)
        if not (p.startswith("src/") or p.startswith("lib/") or p.startswith("pkg/")
                or p.startswith("internal/") or p.startswith("cmd/")):
            continue
        basename = p.rsplit("/", 1)[-1].lower()
        if any(basename.startswith(x) for x in ("test", "spec", "_test")):
            continue
        if any(x in p.lower() for x in ("/vendor/", "/generated/", "/docs/", "/testdata/")):
            continue
        seen.add(p)
        paths.append(p)
        if len(paths) >= max_files:
            break

    headers = _github_headers(os.environ.get("GH_TOKEN"))
    out: dict[str, str] = {}
    total = 0
    for path in paths:
        if total >= max_total_bytes:
            break
        try:
            resp = await client.get(
                f"https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/{path}",
                headers=headers, timeout=8.0,
            )
            if resp.status_code != 200:
                continue
            content = resp.text
            if len(content) > 6_000:
                content = content[:6_000] + "\n... (truncated)"
            out[path] = content
            total += len(content)
        except (httpx.HTTPError, Exception):  # noqa: BLE001
            continue
    return out


def _detect_entry_points(tree: list[dict[str, Any]]) -> list[str]:
    """Heuristic: top-level entry-point files + any file under src/."""
    entry: list[str] = []
    for node in tree:
        path = node.get("path", "")
        if not path:
            continue
        filename = path.rsplit("/", 1)[-1].lower()
        # Only count files; skip directories themselves.
        if node.get("type") != "blob":
            continue
        # Skip deep paths (more than 1 directory deep).
        depth = path.count("/")
        if depth >= 2:
            continue
        # Top-level files (no slash) match by filename.
        # Files in src/ or root/<filename> also match.
        if filename in _ENTRY_POINT_TOP_LEVEL:
            entry.append(path)
    entry.sort()
    return entry[:10]


def _classify_tree(tree: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Mark key files for the renderer to highlight."""
    out: list[dict[str, Any]] = []
    for node in tree:
        top = node["path"].split("/", 1)[0].lower()
        node_copy = dict(node)
        node_copy["key"] = top in _KEY_FILES
        out.append(node_copy)
    return out


def _merge_zread_pages(
    existing_zread: dict[str, Any] | None,
    new_zread: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Merge previously generated Zread pages into a new partial draft.

    A long-running Zread generation can be interrupted by the outer
    enrichment timeout (``RADAR_ENRICHMENT_ITEM_TIMEOUT_SECONDS``) or by a
    network/LLM failure.  The CLI returns the pages already written to its
    ``drafts/`` directory at that point.  Without this merge the new partial
    would overwrite every page that a previous run had already persisted and
    silently regress a wiki that had 28 pages to one with 1 page.

    The merge is conservative:

    * A complete new document replaces the old one, even when the repository
      commit changed.
    * An incomplete new document merges with the old pages even across
      commits. This avoids regressing a readable 29-page snapshot to a
      one-page draft while a durable CLI resume is still filling the gap.
      The payload records the previous commit so mixed-version pages remain
      observable until the new document becomes complete.
    * New pages win on ``path`` conflict because the freshest content reflects
      the current repo state.
    * Other fields (``status``, ``expectedPageCount``, ``commitSha``, etc.)
      always come from the new payload so the persisted record matches the
      latest run.
    """
    if not isinstance(existing_zread, dict) or not isinstance(new_zread, dict):
        return new_zread
    existing_pages = existing_zread.get("pages")
    new_pages = new_zread.get("pages")
    # The CLI failed before producing any pages (e.g. ``git clone`` couldn't
    # reach GitHub).  ``new_zread`` carries the failure metadata but no
    # ``pages`` list.  Without this branch the persisted wiki would silently
    # regress from N usable pages to 0 pages and lose the prior enrichment.
    # Preserve the existing pages while still surfacing the failure so the
    # UI / retry loop can react to it.
    if not isinstance(new_pages, list):
        if (
            isinstance(existing_pages, list)
            and existing_pages
            and not _zread_pages_complete(new_zread)
        ):
            merged_payload = dict(new_zread)
            merged_payload["pages"] = existing_pages
            merged_payload["pageCount"] = len(existing_pages)
            if existing_zread.get("commitSha") != new_zread.get("commitSha"):
                merged_payload["previousCommitSha"] = existing_zread.get("commitSha")
                merged_payload["mixedCommits"] = True
            return merged_payload
        return new_zread
    if not isinstance(existing_pages, list) or not isinstance(new_pages, list):
        return new_zread
    existing_commit = existing_zread.get("commitSha")
    new_commit = new_zread.get("commitSha")
    if _zread_pages_complete(new_zread):
        return new_zread
    new_by_path: dict[str, dict[str, Any]] = {}
    for page in new_pages:
        if isinstance(page, dict):
            path = page.get("path")
            if path:
                new_by_path[path] = page
    merged: list[dict[str, Any]] = list(new_pages)
    seen_paths = set(new_by_path.keys())
    for page in existing_pages:
        if not isinstance(page, dict):
            continue
        path = page.get("path")
        if not path or path in seen_paths:
            continue
        merged.append(page)
        seen_paths.add(path)
    merged_payload = dict(new_zread)
    merged_payload["pages"] = merged
    merged_payload["pageCount"] = len(merged)
    if existing_commit and new_commit and existing_commit != new_commit:
        merged_payload["previousCommitSha"] = existing_commit
        merged_payload["mixedCommits"] = True
    return merged_payload


def _zread_pages_complete(payload: Any) -> bool:
    """Return true only when a Zread payload has no catalog page gap."""
    if not isinstance(payload, dict):
        return False
    if (
        payload.get("status") != "complete"
        or payload.get("truncated")
        or payload.get("missingPages")
        or payload.get("mixedCommits")
    ):
        return False
    try:
        page_count = int(payload.get("pageCount") or 0)
        expected_page_count = int(payload.get("expectedPageCount") or 0)
    except (TypeError, ValueError):
        return False
    if expected_page_count > 0:
        return page_count >= expected_page_count and bool(payload.get("pages"))
    return payload.get("status") == "complete" and bool(payload.get("pages"))


def _build_meta_payload(
    repo_meta: dict[str, Any] | None,
    tree: list[dict[str, Any]],
    entry_points: list[str],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "provider": "github",
        "enrichmentVersion": ENRICHMENT_VERSION,
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tree": _classify_tree(tree),
        "entryPoints": entry_points,
    }
    if repo_meta:
        payload.update(repo_meta)
    return payload


def _trim_to_budget(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop oldest tree nodes if JSON exceeds ORIGINAL_META_MAX_BYTES."""
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(encoded) <= ORIGINAL_META_MAX_BYTES:
        return payload
    # Trim tree iteratively until under budget. Keep key files + entry
    # points intact by moving them to the head before trimming.
    tree = payload.get("tree", [])
    key_paths = {e["path"] for e in tree if e.get("key")}
    head = [n for n in tree if n["path"] in key_paths or n["path"] in payload.get("entryPoints", [])]
    tail = [n for n in tree if n not in head]
    while tail and len(json.dumps({**payload, "tree": head + tail}, ensure_ascii=False).encode("utf-8")) > ORIGINAL_META_MAX_BYTES:
        tail.pop()
    payload["tree"] = head + tail
    payload["trimmed"] = True
    return payload


def _zread_scoring_markdown(
    zread_payload: dict[str, Any] | None,
    readme_text: str | None,
) -> str:
    """Build the authoritative GitHub reader/scoring body.

    Public Zread pages are preferred and kept in page order. README is only
    used when no readable Zread page exists.
    """
    parts: list[str] = []
    pages = zread_payload.get("pages") if isinstance(zread_payload, dict) else None
    if isinstance(pages, list):
        for page in pages:
            if not isinstance(page, dict):
                continue
            content = _strip_nul(str(page.get("content") or "")).strip()
            if not content:
                continue
            title = _strip_nul(str(page.get("title") or page.get("path") or "")).strip()
            path = _strip_nul(str(page.get("path") or "")).strip()
            heading = title or path
            block = f"# {heading}\n\n" if heading else ""
            if path and path != heading:
                block += f"_Source: {path}_\n\n"
            parts.append(block + content)
    markdown = "\n\n---\n\n".join(parts).strip()
    if not markdown and readme_text:
        markdown = _strip_nul(readme_text).strip()
    return markdown


async def enrich_github_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
    force: bool = False,
    lease_owner: str | None = None,
    claim_id: str | None = None,
) -> dict[str, Any] | None:
    """Enrich one GitHub repo candidate; returns the persisted meta or None.

    Returns None when the URL isn't a repo URL or enrichment failed.
    Caller is responsible for catching all exceptions (we log + return None).
    """
    if _is_repo_activity_digest_url(canonical_url):
        logger.info(
            "ai-engine.radar.enrichment.github_digest_skipped",
            extra={"summary_id": summary_id, "url": canonical_url},
        )
        return None
    parsed = _parse_repo_path(canonical_url)
    if not parsed:
        return None
    owner, repo = parsed
    current = await _fetch_enrichment_row(pool, summary_id)
    existing_meta = current.get("originalMeta") if isinstance(current, dict) else None
    existing_zread = existing_meta.get("zread") if isinstance(existing_meta, dict) else None

    async with httpx.AsyncClient(follow_redirects=True) as client:
        repo_meta = await _fetch_repo_meta(client, owner, repo)
        default_branch = (repo_meta or {}).get("defaultBranch") or "main"
        head_sha = await _fetch_repo_head_sha(client, owner, repo, default_branch)
        tree = await _fetch_repo_tree(client, owner, repo, default_branch)
        readme_text = await _fetch_repo_readme(client, owner, repo, default_branch)
        key_files = await _fetch_key_files(
            client, owner, repo, default_branch,
            entry_points=_detect_entry_points(tree),
            tree=tree,
        )
    entry_points = _detect_entry_points(tree)
    payload = _build_meta_payload(repo_meta, tree, entry_points)
    payload = _trim_to_budget(payload)

    # Zread is deliberately a separate best-effort step. Reuse the public
    # Zread wiki first; only generate locally when the already-indexed public
    # pages are unavailable. A remote cache is keyed by its indexed commit.
    # Once a local CLI draft exists, it is the authoritative resumable work
    # product for this repository. Retrying remote first would add a slow,
    # unrelated network dependency and could replace a useful local draft
    # with a different/partial public catalog. New repositories still keep
    # the normal remote-first policy.
    existing_cli_draft = (
        isinstance(existing_zread, dict)
        and existing_zread.get("provider") == "zread-cli"
        and isinstance(existing_zread.get("pages"), list)
        and bool(existing_zread.get("pages"))
    )
    zread_payload = existing_zread if (
        not force
        and not existing_cli_draft
        and
        isinstance(existing_zread, dict)
        and (
            existing_zread.get("provider") == "zread-remote"
            and existing_zread.get("repoHeadSha") == head_sha
            and existing_zread.get("commitSha")
            and existing_zread.get("parserVersion") == 4
        )
        and isinstance(existing_zread.get("pages"), list)
        and _zread_pages_complete(existing_zread)
    ) else None
    # Remote retrieval and local generation are separate providers. Disabling
    # the CLI must never disable fetching an already-published Zread wiki.
    zread_cli_enabled = os.environ.get("ZREAD_CLI_ENABLED", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }
    if zread_payload is None and not existing_cli_draft:
        try:
            from ai_engine.radar.zread_remote import fetch_zread_wiki

            zread_payload = await fetch_zread_wiki(owner=owner, repo=repo)
            if isinstance(zread_payload, dict):
                zread_payload["repoHeadSha"] = head_sha
        except Exception as exc:  # noqa: BLE001 - optional enrichment must not block radar
            logger.warning(
                "ai-engine.radar.enrichment.zread_remote_failed",
                extra={"summary_id": summary_id, "owner": owner, "repo": repo, "error": type(exc).__name__},
            )
    remote_payload = (
        zread_payload
        if isinstance(zread_payload, dict)
        and zread_payload.get("provider") == "zread-remote"
        else None
    )
    remote_complete = _zread_pages_complete(remote_payload)
    # A remote catalog with missing pages is not a usable document. Try the
    # local generator for both "remote unavailable" and "remote partial";
    # retain the remote partial only when the CLI cannot produce anything.
    if zread_cli_enabled and not remote_complete:
        try:
            from ai_engine.radar.zread_cli import generate_zread_wiki

            cli_payload = await generate_zread_wiki(
                owner=owner,
                repo=repo,
                branch=default_branch,
                commit_sha=head_sha,
            )
            if isinstance(cli_payload, dict) and cli_payload.get("pages"):
                zread_payload = cli_payload
            elif remote_payload is not None:
                zread_payload = remote_payload
        except Exception as exc:  # noqa: BLE001 - optional enrichment must not block radar
            error_message = str(exc).strip().replace("\n", " ")[-500:] or type(exc).__name__
            if remote_payload is not None:
                zread_payload = {
                    **remote_payload,
                    "error": f"Zread CLI fallback failed; retained remote partial: {error_message}",
                }
            else:
                zread_payload = {
                    "provider": "zread-cli",
                    "status": "failed",
                    "repository": f"{owner}/{repo}",
                    "commitSha": head_sha,
                    "branch": default_branch,
                    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "error": error_message,
                }
            logger.warning(
                "ai-engine.radar.enrichment.zread_cli_failed",
                extra={"summary_id": summary_id, "owner": owner, "repo": repo, "error": error_message},
            )
    # A high-value Repo must still have readable content when Zread is
    # unavailable or times out before writing its first page. README is the
    # authoritative GitHub source fallback; it is explicitly marked partial
    # so the UI never presents it as a complete generated wiki.
    if (
        zread_payload is None
        and isinstance(existing_zread, dict)
        and isinstance(existing_zread.get("pages"), list)
        and existing_zread.get("pages")
    ):
        # A transient Zread refresh failure must not destroy a previously
        # usable wiki by replacing it with a one-page README fallback.
        payload["zread"] = {
            **existing_zread,
            "error": "Zread refresh unavailable; retained the previous cached wiki",
        }
    elif zread_payload is None and readme_text:
        zread_payload = {
            "provider": "github-readme-fallback",
            "status": "partial",
            "repository": f"{owner}/{repo}",
            "commitSha": head_sha,
            "branch": default_branch,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "error": "Zread unavailable; showing GitHub README fallback",
            "pageCount": 1,
            "expectedPageCount": 1,
            "truncated": False,
            "truncatedPages": [],
            "fallback": True,
            "pages": [{
                "path": "README.md",
                "title": f"{owner}/{repo} README",
                "content": readme_text[:README_MAX_CHARS],
            }],
        }
    elif isinstance(zread_payload, dict) and zread_payload.get("status") == "failed" and readme_text:
        zread_payload = {
            **zread_payload,
            "status": "partial",
            "provider": "github-readme-fallback",
            "fallback": True,
            "pageCount": 1,
            "expectedPageCount": 1,
            "pages": [{
                "path": "README.md",
                "title": f"{owner}/{repo} README",
                "content": readme_text[:README_MAX_CHARS],
            }],
        }
    elif (
        zread_payload is None
        and isinstance(payload.get("zread"), dict)
        and payload["zread"].get("provider") == "github-readme-fallback"
    ):
        # The README request may fail on a retry, but an earlier fallback is
        # still readable. Do not leave a stale "generating" marker after the
        # worker has finished.
        payload["zread"] = {
            **payload["zread"],
            "status": "partial",
            "error": "Zread unavailable; retained existing GitHub README fallback",
        }
    if zread_payload is not None:
        # Normalize provider output at the persistence boundary. Remote
        # Next.js flight data and local CLI drafts can each add another
        # escaping layer; keeping this here prevents a later refresh from
        # reintroducing visible ``\uXXXX`` text after a historical backfill.
        payload["zread"] = _scrub_zread_payload(zread_payload)
        # The CLI frequently returns a partial draft when an outer timeout
        # (RADAR_ENRICHMENT_ITEM_TIMEOUT_SECONDS) or a network/LLM hiccup
        # interrupts generation.  Merge with the previously persisted wiki
        # by page path so a successful earlier run is not silently lost.
        if isinstance(existing_zread, dict) and payload["zread"].get("status") != "complete":
            payload["zread"] = _merge_zread_pages(existing_zread, payload["zread"])

    # Phase 2D: AI-written summary (500 words, styled after deepwiki.com's
    # Overview + What Is sections). Best-effort, doesn't break meta write.
    repo_summary = str(current.get("repoSummary") or "").strip() or None
    repo_summary_llm_enabled = os.environ.get(
        "GITHUB_REPO_SUMMARY_LLM_ENABLED", "0"
    ).strip().lower() in {"1", "true", "yes", "on"}
    if readme_text and repo_summary_llm_enabled:
        try:
            repo_summary = await _generate_repo_summary(
                owner=owner, repo=repo,
                readme=readme_text,
                entry_points=entry_points,
                key_files=key_files,
            )
        except Exception as exc:
            logger.warning(
                "ai-engine.radar.enrichment.repo_summary_failed",
                extra={
                    "summary_id": summary_id,
                    "owner": owner, "repo": repo,
                    "error": type(exc).__name__,
                },
            )

    scoring_markdown = _zread_scoring_markdown(
        payload.get("zread") if isinstance(payload.get("zread"), dict) else None,
        readme_text,
    ) or _strip_nul(str(current.get("originalMarkdown") or "")).strip()
    markdown_bytes = scoring_markdown.encode("utf-8")
    payload["readerMarkdownComplete"] = True
    payload["readerMarkdownBytes"] = len(markdown_bytes)

    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMeta" = %s::jsonb, '
            '"originalMarkdown" = %s, '
            '"originalSha256" = %s, '
            '"originalBytes" = %s, '
            '"originalFetchedAt" = now(), '
            '"repoSummary" = %s, '
            f'{enrichment_review_reset_assignments()}, '
            '"updatedAt" = now() '
            'WHERE "id" = %s'
            f'{_lease_guard(lease_owner, claim_id)}'
            f'{_RETURNING_ID if lease_owner else ""}',
            (
                json.dumps(payload, ensure_ascii=False),
                scoring_markdown or None,
                hashlib.sha256(markdown_bytes).hexdigest() if markdown_bytes else None,
                len(markdown_bytes) or None,
                repo_summary,
                summary_id,
                *_lease_params(lease_owner, claim_id),
            ),
        )
        if lease_owner and await cursor.fetchone() is None:
            raise EnrichmentLeaseLost(summary_id)
    logger.info(
            "ai-engine.radar.enrichment.github_done",
        extra={
            "summary_id": summary_id,
            "owner": owner,
            "repo": repo,
            "tree_count": len(tree),
            "entry_points": len(entry_points),
            "has_repo_summary": repo_summary is not None,
            "has_zread": bool(zread_payload),
            "payload_bytes": len(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
        },
    )
    return payload


# ─────────────────────────────────────────────────────────────────────
# Phase 2B — arxiv PDF enrichment
# ─────────────────────────────────────────────────────────────────────


_ARXIV_ID_RE = _re_arxiv.compile(
    r"(?:arxiv\.org/(?:abs|html|pdf)/|huggingface\.co/papers/|abs/)?([0-9]{4}\.[0-9]{4,6}(?:v[0-9]+)?)"
)


def _parse_arxiv_id(url: str) -> str | None:
    """Extract arxiv id like 2401.12345 from a paper URL."""
    m = _ARXIV_ID_RE.search(url or "")
    return m.group(1) if m else None


async def _fetch_arxiv_html(arxiv_id: str) -> tuple[str, str] | None:
    """Fetch a rendered arXiv document, preferring ar5iv over arXiv HTML."""
    urls = (
        f"https://ar5iv.labs.arxiv.org/html/{arxiv_id}",
        f"https://arxiv.org/html/{arxiv_id}",
        f"https://arxiv.org/html/{arxiv_id}v1",
    )
    async with httpx.AsyncClient(
        timeout=30.0,
        follow_redirects=True,
        headers={"User-Agent": "deep-research-radar-enrichment/1.0"},
    ) as client:
        for url in urls:
            try:
                response = await client.get(url)
                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                if "html" not in content_type and not response.text.lstrip().startswith("<"):
                    continue
                final_path = urlsplit(str(response.url)).path.lower()
                # arXiv may redirect an unavailable HTML rendering to the
                # abstract page. That page is useful metadata, but must not
                # be mistaken for the paper body.
                if "/html/" not in final_path or len(response.text.strip()) < 1000:
                    continue
                return response.text, str(response.url)
            except (httpx.HTTPError, UnicodeError) as exc:
                logger.info(
                    "ai-engine.radar.enrichment.arxiv_html_fetch_failed",
                    extra={"arxiv_id": arxiv_id, "url": url, "error": type(exc).__name__},
                )
    return None


def _arxiv_html_authors(html: str) -> list[str]:
    """Read citation_author metadata before falling back to the author block."""
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        authors: list[str] = []
        for node in soup.select('meta[name="citation_author"]'):
            value = str(node.get("content") or "").strip()
            if value and value not in authors:
                authors.append(value)
        if authors:
            return authors
        for node in soup.select(".ltx_authors .ltx_personname, .authors"):
            value = " ".join(node.get_text(" ", strip=True).split())
            if value and value not in authors:
                authors.append(value)
        return authors
    except Exception:
        return []


def _arxiv_html_figures(html: str, base_url: str) -> list[dict[str, Any]]:
    """Collect usable figure metadata from arXiv HTML.

    arXiv HTML commonly uses ``<object data="...svg">`` rather than ``img``.
    The Markdown extractor can render that URL, but the enrichment metadata
    also needs to report the figures so coverage and future figure navigation
    do not claim that a paper has zero figures.
    """
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        figures: list[dict[str, Any]] = []
        for index, figure in enumerate(soup.select("figure[id]"), start=1):
            graphic = figure.find(["object", "img", "svg"])
            if graphic is None:
                continue
            figure_id = str(figure.get("id") or "")
            figure_number_match = _re.search(r"\.F(\d+)$", figure_id)
            figure_number = (
                int(figure_number_match.group(1))
                if figure_number_match
                else index
            )
            raw_url = str(
                graphic.get("data")
                or graphic.get("src")
                or graphic.get("data-src")
                or ""
            ).strip()
            image_url = urljoin(base_url, raw_url) if raw_url else None
            if image_url and urlsplit(image_url).scheme not in {"http", "https"}:
                image_url = None
            caption_node = figure.find("figcaption")
            caption = None
            if caption_node is not None:
                # MathML exposes both visible glyphs and an annotation node.
                # Replace each math element with its TeX alt text first so
                # metadata does not contain artifacts such as "32 32".
                caption_soup = BeautifulSoup(str(caption_node), "html.parser")
                for math_node in caption_soup.select("math"):
                    alttext = str(math_node.get("alttext") or "").strip()
                    if not alttext:
                        annotation = math_node.select_one("annotation")
                        alttext = annotation.get_text(" ", strip=True) if annotation else ""
                    math_node.replace_with(alttext)
                caption = " ".join(caption_soup.get_text(" ", strip=True).split()) or None
            figures.append({
                "figureId": figure_id,
                "figureNumber": figure_number,
                "page": figure_number,
                "caption": caption,
                "url": image_url,
            })
        return figures[:50]
    except Exception:
        return []


def _sections_from_markdown(markdown: str) -> list[dict[str, Any]]:
    """Create lightweight section anchors from headings in rendered HTML."""
    sections: list[dict[str, Any]] = []
    offset = 0
    for line in markdown.splitlines():
        match = _re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match:
            sections.append({
                "title": match.group(2)[:200],
                "level": min(len(match.group(1)), 3),
                "startOffset": offset,
            })
        offset += len(line) + 1
    return sections[:100]


def _strip_extracted_arxiv_footnotes(value: str) -> str:
    """Remove author footnotes leaked by HTML/PDF extraction."""
    value = _re.sub(
        r"(?:^|[\n ])[*_~`†‡⁎✝0-9\s]{0,24}footnotetext\s*:\s*.*?"
        r"(?=\s+(?:#{1,6}\s|!\[|[*_~`†‡⁎✝0-9\s]{0,24}footnotetext\s*:)|$)",
        "\n",
        value,
        flags=_re.IGNORECASE | _re.MULTILINE | _re.DOTALL,
    )
    value = _re.sub(r"footnotemark\s*:\s*", "", value, flags=_re.IGNORECASE)
    return _re.sub(r"\n{3,}", "\n\n", value)


def _clean_arxiv_html_markdown(markdown: str, paper_title: str) -> str:
    """Remove arXiv front-matter artifacts emitted by DOM extractors.

    arXiv HTML contains machine-readable title/logo/resource and affiliation
    nodes before the actual document title. Some HTML-to-Markdown extractors
    flatten those custom nodes into visible text, which makes the reader see
    implementation metadata before the paper and also pollutes article-map
    anchors. Keep the first real title heading as the document start and drop
    repeated affiliation placeholders.
    """
    value = markdown.strip()
    if paper_title:
        title_pattern = _re.compile(
            r"(?m)^#{1,6}\s+" + _re.escape(paper_title).replace(r"\ ", r"\s+") + r"\s*$",
            _re.IGNORECASE,
        )
        title_match = title_pattern.search(value)
        if title_match:
            value = value[title_match.start():]

    lines = value.splitlines()
    cleaned: list[str] = []
    for line in lines:
        stripped = line.strip()
        if _re.match(r"^(?:Affiliation:\s*\[|\\(?:titlelogo|contribution|resource)\b)", stripped):
            continue
        cleaned.append(line)
    value = "\n".join(cleaned)
    value = _re.sub(r"\n{3,}", "\n\n", value)
    # arXiv's HTML-to-Markdown path can expose author footnotes with dagger,
    # digit, or Markdown prefixes. They are metadata already represented in
    # the paper header and should not become visible prose in the reader.
    value = _strip_extracted_arxiv_footnotes(value)
    # Some abstract fallbacks preserve TeX emphasis commands as plain text.
    # Strip the presentation command while keeping the words readable.
    for _ in range(3):
        cleaned_value = _re.sub(
            r"\\(?:textbf|textit|emph|texttt|textrm|textsf|textsc|textnormal|underline)"
            r"\{([^{}\n]*)\}",
            r"\1",
            value,
        )
        cleaned_value = _re.sub(
            r"\\href\{([^{}\n]+)\}\{([^{}\n]*)\}",
            r"\2",
            cleaned_value,
        )
        cleaned_value = _re.sub(
            r"\\url\{([^{}\n]+)\}",
            r"\1",
            cleaned_value,
        )
        if cleaned_value == value:
            break
        value = cleaned_value
    # A small number of converted pages contain a model-instruction artifact
    # instead of paper prose. Remove only this exact signature; real appendix
    # prompts and ordinary mentions of reasoning remain untouched.
    value = _re.sub(
        r"\{\{\s*content\s*\|\s*trim\s*\}\}\s*"
        r"You FIRST think about the reasoning process as an internal monologue "
        r"and then provide the final answer\.\s*"
        r"The reasoning process MUST BE enclosed within <think>\s*</think> tags\.\s*"
        r"The final answer MUST BE put in \\boxed\s*\{\}\.?",
        "",
        value,
        flags=_re.IGNORECASE,
    )
    value = (
        value
        .replace("推荐五款最值得买的 s", "推荐五款最值得买的 [产品]")
        .replace("Recommend the top five most worth-buying s", "Recommend the top five most worth-buying [product]")
        .replace("推荐五款口碑较好的 s", "推荐五款口碑较好的 [产品]")
        .replace("推荐深圳最值得去的五家 s", "推荐深圳最值得去的五家 [商家]")
        .replace("推荐五款最值得关注的 s", "推荐五款最值得关注的 [产品]")
    )
    return value.strip()


def _split_markdown_table_row(line: str) -> list[str] | None:
    """Split a pipe row without treating escaped math pipes as delimiters."""
    stripped = line.strip()
    if not (stripped.startswith("|") and stripped.endswith("|")):
        return None
    body = stripped[1:-1]
    cells: list[str] = []
    current: list[str] = []
    for index, char in enumerate(body):
        if char == "|" and (index == 0 or body[index - 1] != "\\"):
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    cells.append("".join(current).strip())
    return cells


def _is_markdown_table_separator(line: str) -> bool:
    cells = _split_markdown_table_row(line)
    return bool(cells and all(_re.fullmatch(r":?-{3,}:?", cell) for cell in cells))


def _is_math_cell(cell: str) -> bool:
    return bool(_re.search(r"\$\$[\s\S]*\$\$|\$[^$\n]+\$", cell))


def _is_equation_number(cell: str) -> bool:
    return bool(_re.fullmatch(r"\([A-Za-z0-9.:-]+\)", cell))


def _unwrap_arxiv_equation_tables(markdown: str) -> str:
    """Turn extractor-generated equation tables back into display math."""
    lines = markdown.splitlines()
    output: list[str] = []
    index = 0

    def strip_math_delimiters(cell: str) -> str:
        value = _re.sub(r"^\$\$\s*", "", cell)
        value = _re.sub(r"\s*\$\$$", "", value)
        value = _re.sub(r"^\$\s*", "", value)
        value = _re.sub(r"\s*\$$", "", value)
        return value.strip()

    while index < len(lines):
        first_row = _split_markdown_table_row(lines[index])
        separator = lines[index + 1] if index + 1 < len(lines) else ""
        if first_row is None or not _is_markdown_table_separator(separator):
            output.append(lines[index])
            index += 1
            continue

        rows: list[list[str]] = []
        end = index
        while end < len(lines):
            row = _split_markdown_table_row(lines[end])
            if row is None:
                break
            if not _is_markdown_table_separator(lines[end]):
                rows.append(row)
            end += 1

        equation_rows = [row for row in rows if any(cell.strip() for cell in row)]
        if not equation_rows:
            output.append("")
            index = end
            continue
        is_equation_table = bool(equation_rows) and all(
            meaningful
            and any(_is_math_cell(cell) for cell in meaningful)
            and all(_is_math_cell(cell) or _is_equation_number(cell) for cell in meaningful)
            for row in equation_rows
            for meaningful in [[cell.strip() for cell in row if cell.strip()]]
        )
        if not is_equation_table:
            output.append(lines[index])
            index += 1
            continue

        for row in equation_rows:
            meaningful = [cell.strip() for cell in row if cell.strip()]
            formula = " ".join(strip_math_delimiters(cell) for cell in meaningful if _is_math_cell(cell)).strip()
            if not formula:
                continue
            number = next((cell for cell in meaningful if _is_equation_number(cell)), None)
            tag = f"\\tag{{{number[1:-1]}}}" if number else ""
            output.extend(["$$", f"{formula}{tag}", "$$", ""])
        index = end

    return "\n".join(output)


async def _parse_arxiv_html_document(
    arxiv_id: str,
) -> tuple[str, list[dict[str, Any]], list[str], list[dict[str, Any]], str] | None:
    """Return clean Markdown and metadata from ar5iv/arXiv HTML."""
    fetched = await _fetch_arxiv_html(arxiv_id)
    if fetched is None:
        return None
    html, source_url = fetched
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        # trafilatura intentionally drops MathML. Preserve the TeX source as
        # readable inline/display math so the reader never sees blank
        # equations or flattened table-like math fragments.
        for math_node in soup.select("math"):
            tex_node = math_node.select_one('annotation[encoding="application/x-tex"]')
            tex = str(math_node.get("alttext") or (tex_node.get_text() if tex_node else "")).strip()
            if not tex:
                continue
            if str(math_node.get("display") or "").lower() == "block":
                replacement = f"\n\n$$\n{tex}\n$$\n\n"
            else:
                replacement = f" ${tex}$ "
            math_node.replace_with(replacement)

        # Reuse the project's HTML → Markdown pipeline. Unlike PDF text
        # extraction, this retains paragraph and heading boundaries.
        from ai_engine.radar.sync_runner import _extract_article_content

        markdown = _extract_article_content(
            str(soup),
            source_url,
            "arxiv",
            max_bytes=ARXIV_MARKDOWN_MAX_BYTES,
        ).strip()
        # GFM's table normalizer can expose MathML display equations as
        # one- or multi-row tables. Restore them to display-math blocks before
        # the Markdown reaches either the database or ReactMarkdown.
        markdown = _unwrap_arxiv_equation_tables(markdown)
    except Exception as exc:
        logger.info(
            "ai-engine.radar.enrichment.arxiv_html_parse_failed",
            extra={"arxiv_id": arxiv_id, "error": type(exc).__name__},
        )
        return None
    # A full paper should contain more than the abstract page. Short papers
    # still pass when they have multiple rendered headings/paragraphs.
    if len(markdown) < 5000 or len(_sections_from_markdown(markdown)) < 2:
        return None
    # Some arXiv renderings expose the document title/author block both in
    # the front matter and in the extracted article body. Remove the repeated
    # block between the second title and the first numbered section.
    try:
        from bs4 import BeautifulSoup

        title_node = BeautifulSoup(html, "html.parser").select_one("h1.ltx_title_document")
        paper_title = " ".join(title_node.get_text(" ", strip=True).split()) if title_node else ""
        markdown = _clean_arxiv_html_markdown(markdown, paper_title)
        if paper_title:
            title_pattern = _re.compile(_re.escape(paper_title).replace(r"\ ", r"\s+"), _re.IGNORECASE)
            matches = list(title_pattern.finditer(markdown))
            if len(matches) > 1:
                next_section = _re.search(r"\n#{1,6}\s+\d+(?:\.\d+)*\s+", markdown[matches[1].end():])
                if next_section:
                    end = matches[1].end() + next_section.start()
                    markdown = (markdown[:matches[1].start()] + markdown[end:]).strip()
    except Exception:
        pass
    return (
        markdown[:ARXIV_MARKDOWN_MAX_BYTES],
        _sections_from_markdown(markdown),
        _arxiv_html_authors(html),
        _arxiv_html_figures(html, source_url),
        source_url,
    )


def _strip_latex_commands(text: str) -> str:
    """Light LaTeX cleanup — strip braces, comments, common commands.

    pymupdf returns text with raw LaTeX-ish artifacts. We do not aim for
    a full TeX→Markdown conversion (out of scope); just enough that the
    body is readable as paragraphs.
    """
    text = _re_arxiv.sub(r"%[^\n]*", "", text)
    text = _re_arxiv.sub(r"\\textbf\{([^}]*)\}", r"**\1**", text)
    text = _re_arxiv.sub(r"\\textit\{([^}]*)\}", r"*\1*", text)
    text = _re_arxiv.sub(r"\\emph\{([^}]*)\}", r"*\1*", text)
    text = _re_arxiv.sub(r"\\texttt\{([^}]*)\}", r"`\1`", text)
    text = _re_arxiv.sub(r"\\cite\{[^}]*\}", "", text)
    text = _re_arxiv.sub(r"\\ref\{[^}]*\}", "", text)
    text = _re_arxiv.sub(r"\\label\{[^}]*\}", "", text)
    text = _re_arxiv.sub(r"\\href\{([^}]*)\}\{([^}]*)\}", r"[\2](\1)", text)
    text = _re_arxiv.sub(r"\\begin\{[^}]*\}|\\end\{[^}]*\}", "", text)
    return text


async def _fetch_arxiv_pdf(url: str) -> bytes:
    """Fetch arxiv PDF directly via httpx.

    We bypass ``safe_fetch`` because arxiv.org is a fixed trusted domain
    and ``safe_fetch``'s content-type whitelist excludes application/pdf.
    Defence-in-depth: only call this for arxiv ids parsed by
    ``_parse_arxiv_id`` (URL must contain ``arxiv.org/pdf/<id>``).
    """
    import httpx as _httpx_pdf
    async with _httpx_pdf.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            url,
            headers={"User-Agent": "deep-research-radar-enrichment/1.0"},
            follow_redirects=True,
        )
        resp.raise_for_status()
        return resp.content


def _parse_arxiv_pdf(
    pdf_bytes: bytes,
) -> tuple[str, list[dict[str, Any]], list[str], list[dict[str, Any]]]:
    """Parse PDF to (markdown, sections, authors, figures) using pymupdf.

    Returns the full document as markdown-like text, a list of section
    boundaries detected by font-size heuristics, a best-effort author
    list scraped from page 1 (everything above the "Abstract" line), and
    a list of figure metadata {page, caption?}. We don't extract figure
    pixels as base64 in P0 (cost too high); only metadata.
    """
    try:
        import fitz  # type: ignore[import-untyped]  # pymupdf - no type stubs
    except ImportError:
        logger.warning(
            "ai-engine.radar.enrichment.pymupdf_missing",
            extra={},
        )
        return "", [], [], []

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    body_parts: list[str] = []
    sections: list[dict[str, Any]] = []
    authors: list[str] = []
    figures: list[dict[str, Any]] = []
    page_count = doc.page_count
    if page_count == 0:
        doc.close()
        return "", [], [], []

    # First pass: gather font sizes per page to estimate body median.
    body_medians: list[float] = []
    for page in doc:
        blocks = page.get_text("dict")["blocks"]
        sizes: list[float] = []
        for b in blocks:
            for line in b.get("lines", []):
                for span in line.get("spans", []):
                    sizes.append(span.get("size", 0))
        if sizes:
            sizes.sort()
            body_medians.append(sizes[len(sizes) // 2])

    body_median = body_medians[len(body_medians) // 2] if body_medians else 10.0
    heading_threshold = body_median * 1.2

    # ── Authors: scan page 1 lines until we hit "Abstract" ──
    # Heuristic: arXiv layout is title → author block → "Abstract".
    # Author block lines look like "Jennifer D'Souza ¹" or "Jennifer
    # D'Souza*1,†" — short lines with affiliation superscripts.
    if page_count >= 1:
        first_page = doc[0]
        blocks = first_page.get_text("dict")["blocks"]
        abstract_seen = False
        for b in blocks:
            for line in b.get("lines", []):
                text_parts: list[str] = []
                line_size = 0.0
                for span in line.get("spans", []):
                    s = span.get("text", "")
                    if not s.strip():
                        continue
                    text_parts.append(s)
                    line_size = max(line_size, span.get("size", 0))
                line_text = "".join(text_parts).strip()
                if not line_text:
                    continue
                clean = _strip_latex_commands(line_text)
                # Stop at Abstract heading (size > body median or contains the word)
                if _re.search(r"^\s*Abstract\b", clean, flags=_re.IGNORECASE) or (
                    "Abstract" in clean.split() and line_size >= heading_threshold
                ):
                    abstract_seen = True
                    break
                if abstract_seen:
                    break
                # Skip the title (largest font) — author lines tend to be body-sized or smaller
                if line_size > heading_threshold * 1.1:
                    continue
                # Skip obvious non-author lines (emails, urls, single-word affiliations)
                if "@" in clean or clean.startswith("http") or clean.startswith("arXiv:"):
                    continue
                # A reasonable author line has at least one letter, length 3-200, often contains
                # superscript markers like ¹² or commas
                if 3 <= len(clean) <= 250 and _re.search(r"[A-Za-z]", clean):
                    authors.append(clean)
        # De-duplicate while preserving order (some PDFs repeat author list in footnote)
        seen: set[str] = set()
        unique_authors: list[str] = []
        for author in authors:
            if author not in seen:
                seen.add(author)
                unique_authors.append(author)
        authors = unique_authors

    # ── Figures: walk pages, collect image refs + nearby captions ──
    for page_idx, page in enumerate(doc):
        try:
            images = page.get_images(full=True)
        except Exception:
            images = []
        if not images:
            continue
        # Get text blocks to find "Figure N" captions near images
        text_blocks = page.get_text("blocks")  # list of (x0, y0, x1, y1, text, block_no, type)
        figure_captions: dict[int, str] = {}
        for blk in text_blocks:
            if len(blk) < 5:
                continue
            text = str(blk[4]).strip()
            m = _re.match(r"^(Figure\s+\d+)\b", text, flags=_re.IGNORECASE)
            if m:
                # Use block_no as a crude key; just keep first caption per figure number
                number_match = _re.search(r"\d+", m.group(1))
                if number_match:
                    figure_captions.setdefault(int(number_match.group(0)), text[:200])
        for img_idx in range(len(images)):
            fig_num = img_idx + 1
            figures.append({
                "page": page_idx + 1,
                "figureNumber": fig_num,
                "caption": figure_captions.get(fig_num),
            })
    # Cap figures to a sane upper bound to keep payloads small
    if len(figures) > 50:
        figures = figures[:50]

    offset = 0
    for page_idx, page in enumerate(doc):
        blocks = page.get_text("dict")["blocks"]
        for b in blocks:
            for line in b.get("lines", []):
                page_text_parts: list[str] = []
                line_size = 0.0
                for span in line.get("spans", []):
                    s = span.get("text", "")
                    if not s.strip():
                        continue
                    page_text_parts.append(s)
                    line_size = max(line_size, span.get("size", 0))
                line_text = "".join(page_text_parts).strip()
                if not line_text:
                    continue
                clean = _strip_latex_commands(line_text)
                if line_size >= heading_threshold and len(clean) < 200:
                    # Heuristic: short text on big font → heading
                    sections.append({
                        "title": clean[:200],
                        "level": 1 if line_size >= body_median * 1.5 else 2,
                        "startOffset": offset,
                        "page": page_idx + 1,
                    })
                body_parts.append(clean)
                offset += len(clean) + 1  # +1 for newline

    doc.close()
    markdown = "\n\n".join(body_parts)
    markdown = _strip_extracted_arxiv_footnotes(markdown)
    if len(markdown) > ARXIV_MARKDOWN_MAX_BYTES:
        markdown = markdown[:ARXIV_MARKDOWN_MAX_BYTES]
    # doc.close() omitted — pymupdf documents get GC'd; explicit close
    # races with code that still references the doc (e.g. figures loop).
    return markdown, sections, authors, figures


async def _generate_arxiv_analysis(
    markdown: str, title: str
) -> dict[str, Any] | None:
    """Use BRIEF_LLM to generate a structured 5-field paper analysis.

    Schema inspired by dw-dengwei/daily-arXiv-ai-enhanced (Structure
    pydantic model) and the IMRaD academic writing convention. Each
    field is a single short paragraph (target < 200 chars) so the
    detail card never has to runtime-truncate text.

    Fields:
      - tldr:        one-sentence summary ("too long; didn't read")
      - motivation:  why this paper exists, what problem it solves
      - method:     how the paper solves it (key approach + steps)
      - result:     what was achieved (key numbers / comparisons)
      - conclusion: takeaways, limitations, when to apply

    Returns None on failure; caller falls back to existing interpretation.
    """
    import json as _json

    # Resolve brief LLM model from env (same as _run_brief).
    llm_spec = resolve_spec("utility")

    # System + user prompt borrowed from daily-arXiv-ai-enhanced's
    # `ai/system.txt` ("professional paper analyst, concise, terminology")
    # combined with IMRaD-aligned field instructions. Each field asks for
    # <= 200 chars so the detail card renders verbatim without truncation.
    system_prompt = (
        "You are a professional paper analyst. "
        "Avoid unnecessarily long replies; provide concise, detailed, and "
        "precise answers using correct terminology. "
        "Do not fabricate numbers or citations — only describe what the paper says. "
        "Output language: simplified Chinese."
    )
    user_prompt = (
        f"标题: {title}\n\n"
        f"正文 (前 6000 字):\n{markdown[:6000]}\n\n"
        "请按以下 5 个字段输出 JSON (不要 markdown 代码块、不要解释):\n"
        "{\n"
        '  "tldr": "一句话总结，不超过 100 字",\n'
        '  "motivation": "研究动机 / 为什么做这个问题，不超过 200 字",\n'
        '  "method": "本文方案的关键步骤 / 方法，不超过 200 字",\n'
        '  "result": "实验结果 / 关键数字 / 对比，不超过 200 字",\n'
        '  "conclusion": "结论 / 适用场景 / 局限，不超过 200 字"\n'
        "}\n"
    )

    try:
        result = await generate_text(
            llm_spec=llm_spec,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=4096,
            disable_thinking=True,
            operation="radar.enrichment.arxiv_analysis",
        )
        text = result.text
        if not text:
            logger.warning(
                "ai-engine.radar.enrichment.arxiv_analysis_empty",
                extra={"reason": "llm_returned_empty"},
            )
            return None
        try:
            parsed = _parse_llm_response(text)
        except (ValueError, TypeError, _json.JSONDecodeError):
            logger.warning(
                "ai-engine.radar.enrichment.arxiv_analysis_json_parse_failed",
                extra={
                    "text_len": len(text),
                    "text_preview": text[:200].replace("\n", " "),
                },
            )
            return None

        # Validate the 5 fields are present and non-empty after NUL scrub.
        scrubbed = _scrub_dict_strings(parsed)
        required = ("tldr", "motivation", "method", "result", "conclusion")
        missing = [k for k in required if not scrubbed.get(k)]
        if missing:
            logger.warning(
                "ai-engine.radar.enrichment.arxiv_analysis_missing_fields",
                extra={"missing": missing},
            )
            return None

        # Cap each field at 500 chars in case the model over-runs. We cap
        # rather than truncate silently because we don't want to display
        # cut-off text — the cap is a hard ceiling enforced by the prompt.
        return {k: str(scrubbed[k])[:500] for k in required}
    except Exception as exc:
        logger.warning(
            "ai-engine.radar.enrichment.arxiv_analysis_failed",
            extra={"error": type(exc).__name__, "error_message": str(exc)[:200]},
        )
        return None


async def _generate_repo_summary(
    *,
    owner: str,
    repo: str,
    readme: str,
    entry_points: list[str],
    key_files: dict[str, str] | None = None,
) -> str | None:
    """Use BRIEF_LLM to generate a ~500-word project overview.

    Patterned after deepwiki.com's "Overview" + "What Is" sections —
    explains what the project does, why it exists, how it works, key
    architectural decisions, and who it's for.

    Passes README full text + key source files so the LLM has real
    facts to work with, not just a repo name.

    Returns a single paragraph of ~500 chars (Chinese), or None on
    failure.
    """
    llm_spec = resolve_spec("utility")

    key_files = key_files or {}
    src_fragments: list[str] = []
    for path, content in key_files.items():
        block = f"\n--- {path} ---\n{content}"
        if sum(len(s) for s in src_fragments) + len(block) > 12_000:
            break
        src_fragments.append(content[:4_000])

    system_prompt = (
        "You are a senior developer introducing a GitHub project to a new "
        "team member. Write in plain, factual Chinese. Based only on the "
        "README and source code provided, explain in a single article (no "
        "lists, no file paths): what this project does, why it exists, how "
        "it works at a high level (main components and their roles), one "
        "key architectural decision, and who should use it. "
        "Output language: simplified Chinese."
    )
    user_prompt = (
        f"仓库: {owner}/{repo}\n\n"
        f"README:\n{readme[:12000]}\n\n"
        f"关键源码:\n{chr(10).join(src_fragments[:3])}\n\n"
        "请输出一段 400-600 字的项目概述，不要 markdown 列表或文件路径。"
        "自然语言，5-6 个短段落，每段 1-3 句话。"
    )

    try:
        result = await generate_text(
            llm_spec=llm_spec,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=4096,
            disable_thinking=True,
            operation="radar.enrichment.repo_summary",
        )
        text = result.text
        if not text:
            return None
        return text[:2000]
    except Exception:
        return None

async def enrich_arxiv_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
    lease_owner: str | None = None,
    claim_id: str | None = None,
) -> dict[str, Any] | None:
    """Enrich one arxiv paper candidate; returns the persisted meta or None.

    Pipeline:
    1. Parse arxiv id from URL
    2. Fetch and parse ar5iv/arXiv HTML
    3. Fall back to PDF parsing only when rendered HTML is unavailable
    4. Generate TL;DR via BRIEF_LLM
    5. Persist originalMarkdown + sections + tldr + figures + authors
    """
    arxiv_id = _parse_arxiv_id(canonical_url)
    if not arxiv_id:
        logger.warning(
            "ai-engine.radar.enrichment.arxiv_id_parse_failed",
            extra={"summary_id": summary_id, "url": canonical_url},
        )
        return None

    html_result = await _parse_arxiv_html_document(arxiv_id)
    source_url = f"https://arxiv.org/abs/{arxiv_id}"
    extraction_method = "arxiv-html-v1"
    if html_result is not None:
        markdown, sections, authors, figures, source_url = html_result
    else:
        pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
        try:
            pdf_bytes = await _fetch_arxiv_pdf(pdf_url)
        except Exception as exc:
            logger.warning(
                "ai-engine.radar.enrichment.arxiv_pdf_fetch_failed",
                extra={"summary_id": summary_id, "arxiv_id": arxiv_id, "error": type(exc).__name__},
            )
            return await _enrich_arxiv_from_cached_abstract(
                pool,
                summary_id=summary_id,
                arxiv_id=arxiv_id,
                reason="html_and_pdf_fetch_failed",
                lease_owner=lease_owner,
                claim_id=claim_id,
            )

        if len(pdf_bytes) > 8 * 1024 * 1024:
            logger.warning(
                "ai-engine.radar.enrichment.arxiv_pdf_too_large",
                extra={"summary_id": summary_id, "arxiv_id": arxiv_id, "bytes": len(pdf_bytes)},
            )
            return await _enrich_arxiv_from_cached_abstract(
                pool,
                summary_id=summary_id,
                arxiv_id=arxiv_id,
                reason="pdf_too_large",
                lease_owner=lease_owner,
                claim_id=claim_id,
            )

        markdown, sections, authors, figures = _parse_arxiv_pdf(pdf_bytes)
        extraction_method = "arxiv-pdf-fallback-v1"
    if not markdown:
        logger.warning(
            "ai-engine.radar.enrichment.arxiv_pdf_empty",
            extra={"summary_id": summary_id, "arxiv_id": arxiv_id},
        )
        return None

    # Scrub NUL bytes — pymupdf output occasionally carries 0x00 from
    # font table padding, which Postgres text columns reject.
    markdown = _strip_nul(markdown)
    sections = _scrub_dict_strings(sections)
    authors = [_strip_nul(a) for a in authors]

    # Fetch current title from DB
    async with pool.connection() as conn:
        title_row = await (
            await conn.execute(
                'SELECT "title", "tldr", "arxivAnalysis" FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
        if title_row is None:
            title = arxiv_id
            existing_tldr = None
            existing_analysis = None
        else:
            # pool.connection() may return dict_row (mapping) or tuple
            try:
                title = str(title_row["title"])  # dict-like
                existing_tldr = title_row.get("tldr")
                existing_analysis = title_row.get("arxivAnalysis")
            except (TypeError, KeyError):
                title = str(title_row[0])  # tuple-like
                existing_tldr = title_row[1] if len(title_row) > 1 else None
                existing_analysis = title_row[2] if len(title_row) > 2 else None

    generated_analysis = await _generate_arxiv_analysis(markdown, title)
    analysis = generated_analysis or (
        existing_analysis if isinstance(existing_analysis, dict) else None
    )
    tldr_text: str | None = (
        str((generated_analysis or {}).get("tldr") or "").strip()
        or str(existing_tldr or "").strip()
        or None
    )

    # Update DB row
    meta_payload = {
        "provider": "arxiv",
        "enrichmentVersion": ENRICHMENT_VERSION,
        "sourceUrl": source_url,
        "extractorVersion": extraction_method,
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "arxivId": arxiv_id,
        "sectionCount": len(sections),
        "authorCount": len(authors),
        "figureCount": len(figures),
        "figures": figures[:20],  # keep meta payload small; full list in figures column
        "readerMarkdownComplete": len(markdown.encode("utf-8")) < ARXIV_MARKDOWN_MAX_BYTES,
        "readerMarkdownBytes": len(markdown.encode("utf-8")),
    }
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMarkdown" = %s, '
            '"originalSha256" = %s, '
            '"originalMeta" = %s::jsonb, '
            '"sections" = %s::jsonb, '
            '"tldr" = %s, '
            '"arxivAnalysis" = %s::jsonb, '
            '"authors" = %s, '
            '"figures" = %s::jsonb, '
            '"originalBytes" = %s, '
            '"originalFetchedAt" = now(), '
            f'{enrichment_review_reset_assignments()}, '
            '"updatedAt" = now() '
            'WHERE "id" = %s'
            f'{_lease_guard(lease_owner, claim_id)}'
            f'{_RETURNING_ID if lease_owner else ""}',
            (
                markdown,
                hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
                json.dumps(meta_payload, ensure_ascii=False),
                json.dumps(sections, ensure_ascii=False),
                tldr_text,
                json.dumps(analysis, ensure_ascii=False) if analysis else None,
                authors[:30],  # cap to top 30 authors (most arxiv papers fit)
                json.dumps(figures, ensure_ascii=False),
                len(markdown.encode("utf-8")),
                summary_id,
                *_lease_params(lease_owner, claim_id),
            ),
        )
        if lease_owner and await cursor.fetchone() is None:
            raise EnrichmentLeaseLost(summary_id)
    logger.info(
        "ai-engine.radar.enrichment.arxiv_done",
        extra={
            "summary_id": summary_id,
            "arxiv_id": arxiv_id,
            "sections": len(sections),
            "markdown_bytes": len(markdown.encode("utf-8")),
            "tldr": tldr_text is not None,
            "analysis_fields": list((analysis or {}).keys()),
        },
    )
    return {
        "markdown": markdown,
        "sections": sections,
        "tldr": tldr_text,
        "analysis": analysis,
        "authors": authors,
        "figures": figures,
    }


async def _enrich_arxiv_from_cached_abstract(
    pool: Any,
    *,
    summary_id: str,
    arxiv_id: str,
    reason: str,
    lease_owner: str | None = None,
    claim_id: str | None = None,
) -> dict[str, Any] | None:
    """Persist useful arXiv analysis when the full PDF cannot be processed."""
    current = await _fetch_enrichment_row(pool, summary_id)
    if not current:
        return None
    markdown = _strip_nul(str(current.get("originalMarkdown") or "")).strip()
    if not markdown:
        return None
    title = str(current.get("title") or arxiv_id)
    analysis = await _generate_arxiv_analysis(markdown, title)
    tldr = (
        str((analysis or {}).get("tldr") or "").strip()
        or str(current.get("tldr") or current.get("interpretation") or "").strip()
    )[:500]
    meta_payload = {
        "provider": "arxiv",
        "enrichmentVersion": ENRICHMENT_VERSION,
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "arxivId": arxiv_id,
        "sectionCount": 0,
        "authorCount": 0,
        "figureCount": 0,
        "figures": [],
        "degraded": True,
        "reason": reason,
    }
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET "originalMeta" = %s::jsonb, '
            '"originalSha256" = %s, '
            '"tldr" = COALESCE("tldr", %s), '
            '"arxivAnalysis" = COALESCE("arxivAnalysis", %s::jsonb), '
            '"originalBytes" = COALESCE("originalBytes", %s), '
            '"originalFetchedAt" = COALESCE("originalFetchedAt", now()), '
            f'{enrichment_review_reset_assignments()}, '
            '"updatedAt" = now() WHERE "id" = %s'
            f'{_lease_guard(lease_owner, claim_id)}'
            f'{_RETURNING_ID if lease_owner else ""}',
            (
                json.dumps(meta_payload, ensure_ascii=False),
                hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
                tldr or None,
                json.dumps(analysis, ensure_ascii=False) if analysis else None,
                len(markdown.encode("utf-8")),
                summary_id,
                *_lease_params(lease_owner, claim_id),
            ),
        )
        if lease_owner and await cursor.fetchone() is None:
            raise EnrichmentLeaseLost(summary_id)
    return {
        "markdown": markdown,
        "sections": [],
        "tldr": tldr or None,
        "analysis": analysis,
        "authors": [],
        "figures": [],
        "meta": meta_payload,
    }


async def _run_enrichment_for_pending(
    pool: Any,
    *,
    limit: int = 50,
    source_kinds: tuple[str, ...] = DEFAULT_ENRICHMENT_KINDS,
    sync_run_ids: tuple[str, ...] | None = None,
    summary_ids: tuple[str, ...] | None = None,
    concurrency: int | None = None,
    force: bool = False,
    item_timeout: float | None = None,
    run_id: str | None = None,
) -> int:
    """Find candidates that need enrichment and process them.

    A candidate needs enrichment if:
    - ``originalKind`` matches one of ``source_kinds``
    - it is a ``collection`` or ``deep_read`` item
    - its source-specific enrichment is incomplete
    - it came from a real sync, or is an approved user candidate

    Dispatches by source kind to the right enricher (github → REST,
    arxiv → PDF parse + LLM TL;DR).

    Returns count of successfully enriched rows.
    """
    enrichment_concurrency = max(
        1,
        concurrency
        or int(os.environ.get("RADAR_ENRICHMENT_CONCURRENCY", "2")),
    )
    claim_limit = min(max(1, limit), enrichment_concurrency)
    await recover_expired_enrichment_leases(
        pool,
        limit=max(claim_limit, 50),
    )
    placeholders = ",".join(["%s"] * len(source_kinds))
    run_filter = ""
    summary_filter = ""
    params: tuple[Any, ...] = (*source_kinds,)
    if summary_ids:
        summary_placeholders = ",".join(["%s"] * len(summary_ids))
        summary_filter = f'AND "id" IN ({summary_placeholders}) '
        params = (*params, *summary_ids)
    if sync_run_ids:
        run_placeholders = ",".join(["%s"] * len(sync_run_ids))
        run_filter = (
            f'AND ("syncRunId" IN ({run_placeholders}) OR EXISTS ('
            'SELECT 1 FROM "share_submissions" sh '
            'WHERE sh."publishedSummaryId" = "summaries"."id" '
            'AND sh."status" = \'approved\')) '
        )
        params = (*params, *sync_run_ids)
    # Keep each legacy predicate independently balanced.  This is deliberately
    # assembled as a list rather than one long parenthesized literal: a small
    # condition added to one source must not invalidate the whole claim SQL.
    legacy_enrichment_need = " OR ".join(
        [
            '("originalKind" IN (\'rss\', \'web_share\') AND ('
            '"highlights" IS NULL OR '
            'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\'))',
            # GitHub sync can persist a lightweight repository snapshot before
            # the deep enrichment stage.  Do not mistake that snapshot for a
            # completed enrichment: it has no v2 marker and no Zread pages.
            '("originalKind" = \'github_repo\' '
            'AND "canonicalUrl" NOT LIKE \'%%digest=%%\' AND ('
            '"originalMeta" IS NULL '
            'OR COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\' '
            # Older enrichment silently clipped the reader body at roughly
            # 512KB. Rebuild large rows without the new completeness marker.
            'OR (COALESCE("originalMeta"->>\'readerMarkdownComplete\', \'\') <> \'true\' '
            'AND char_length(COALESCE("originalMarkdown", \'\')) >= 500000) '
            'OR COALESCE("originalMeta"->\'zread\'->>\'status\', \'\') '
            'NOT IN (\'complete\', \'partial\', \'failed\') '
            # A README fallback is deliberately marked partial even though
            # it contains one readable page. It must remain retryable;
            # otherwise pageCount=expectedPageCount=1 makes the fallback
            # permanently mask a missing Zread wiki.
            'OR (COALESCE("originalMeta"->\'zread\'->>\'status\', \'\') = \'partial\' '
            'AND COALESCE(NULLIF("originalMeta"->\'zread\'->>\'generatedAt\', \'\')::timestamptz, '
            'to_timestamp(0)) < now() - '
            f'make_interval(secs => {GITHUB_ENRICHMENT_RETRY_SECONDS})) '
            'OR (COALESCE("originalMeta"->\'zread\'->>\'status\', \'\') = \'failed\' '
            'AND COALESCE(NULLIF("originalMeta"->\'zread\'->>\'generatedAt\', \'\')::timestamptz, '
            'to_timestamp(0)) < now() - '
            f'make_interval(secs => {GITHUB_ENRICHMENT_RETRY_SECONDS})) '
            'OR (COALESCE("originalMeta"->\'zread\'->>\'status\', \'\') = \'complete\' '
            'AND COALESCE(NULLIF("originalMeta"->\'zread\'->>\'expectedPageCount\', \'\'), \'0\')::int > 0 '
            'AND COALESCE(NULLIF("originalMeta"->\'zread\'->>\'pageCount\', \'\'), \'0\')::int '
            '< COALESCE(NULLIF("originalMeta"->\'zread\'->>\'expectedPageCount\', \'\'), \'0\')::int)))',
            '("originalKind" = \'arxiv\' AND ('
            '"arxivAnalysis" IS NULL OR "tldr" IS NULL OR '
            'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\' '
            'OR (COALESCE("originalMeta"->>\'readerMarkdownComplete\', \'\') <> \'true\' '
            'AND char_length(COALESCE("originalMarkdown", \'\')) >= 500000)))',
            '("originalKind" IN (\'github_other\', \'github_issue\', \'github_pr\', \'github_release\') AND ('
            '"originalMeta" IS NULL OR '
            'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\'))',
            '("originalKind" NOT IN (\'rss\', \'web_share\', \'github_repo\') '
            'AND "originalMeta" IS NULL)',
            '("originalKind" IN (\'rss\', \'web_share\') '
            'AND "readerQualityStatus" IN (\'incomplete\', \'invalid\') '
            'AND COALESCE("originalFetchedAt", to_timestamp(0)) < now() - '
            f'make_interval(secs => {WEB_ENRICHMENT_RETRY_SECONDS}))',
        ]
    )
    enrichment_need = (
        'TRUE '
        if force
        else '('
             '("enrichmentStatus" IN (\'pending\', \'retryable\') '
             'AND COALESCE("enrichmentNextRetryAt", to_timestamp(0)) <= now()) '
                f'OR ({legacy_enrichment_need})'
             ') '
    )
    # Distilled scoring already decided the reading depth.  Enrichment is a
    # deeper, more expensive representation and must not run for skim/noise
    # rows. Explicit --summary-id repairs retain the force escape hatch.
    tier_filter = (
        'TRUE' if force
        else '"distilledTier" IN (\'collection\', \'deep_read\')'
    )
    if run_id is None:
        run_id = str(uuid.uuid4())
    state_filter = (
        '("enrichmentStatus" IS DISTINCT FROM \'running\' '
        'OR "enrichmentLeaseExpiresAt" < now() '
        'OR "enrichmentLeaseExpiresAt" IS NULL)'
        if force
        else (
            '("enrichmentStatus" IS NULL '
            'OR "enrichmentStatus" IN (\'pending\', \'retryable\') '
            'AND COALESCE("enrichmentNextRetryAt", to_timestamp(0)) <= now() '
            'OR ("enrichmentStatus" = \'running\' '
            'AND "enrichmentLeaseExpiresAt" < now()))'
        )
    )
    source_filter = (
        'TRUE'
        if force and summary_ids
        else '("source" = \'daily\' OR "syncRunId" IS NOT NULL OR EXISTS ('
             'SELECT 1 FROM "share_submissions" sh '
             'WHERE sh."publishedSummaryId" = "summaries"."id" '
             'AND sh."status" = \'approved\'))'
    )
    # The CTE + UPDATE is one PostgreSQL statement. It is an atomic per-row
    # claim even when the process-level advisory lock is removed later.
    claim_sql = (
        'WITH candidates AS ('
        'SELECT "id" FROM "summaries" '
        f'WHERE "originalKind" IN ({placeholders}) '
        f'AND {tier_filter} '
        f'AND {enrichment_need}'
        f'AND {state_filter} '
        'AND NOT ("originalKind" = \'github_repo\' AND '
        'COALESCE("tags", ARRAY[]::text[]) '
        '@> ARRAY[\'repo_digest\']::text[]) '
        f'AND {source_filter} '
        f"{summary_filter}"
        f"{run_filter}"
        # Retryable work is recovery debt. Serve it before fresh candidates
        # and order by due time so a steady stream of new radar rows cannot
        # starve an older failed source forever.
        'ORDER BY CASE WHEN "enrichmentStatus" = \'retryable\' THEN 0 ELSE 1 END, '
        'COALESCE("enrichmentNextRetryAt", "createdAt") ASC, '
        '"createdAt" ASC LIMIT %s '
        'FOR UPDATE SKIP LOCKED) '
        'UPDATE "summaries" AS s SET '
        '"enrichmentStatus" = \'running\', '
        '"enrichmentAttempts" = COALESCE(s."enrichmentAttempts", 0) + 1, '
        '"enrichmentLockedBy" = %s, '
        '"enrichmentLeaseExpiresAt" = now() + (%s || \' seconds\')::interval, '
        '"enrichmentHeartbeatAt" = now(), '
        '"enrichmentLastAttemptAt" = now(), '
        '"enrichmentRunId" = %s::uuid, '
        '"enrichmentClaimId" = gen_random_uuid(), '
        '"enrichmentNextRetryAt" = NULL, '
        '"enrichmentErrorCode" = NULL, '
        '"enrichmentErrorMessage" = NULL, '
        '"updatedAt" = now() '
        'FROM candidates '
        'WHERE s."id" = candidates."id" '
        'RETURNING s."id", s."canonicalUrl", s."originalKind", '
        's."enrichmentAttempts", s."enrichmentClaimId"'
    )
    # The advisory lock protects only the short claim transaction. Per-row
    # leases and claim tokens already protect the long external enrichment
    # phase, so holding this lock across Zread would unnecessarily block
    # unrelated new candidates.
    async with _ENRICHMENT_RUN_LOCK:
        async with _cross_process_enrichment_lock(pool) as acquired:
            if not acquired:
                return 0
            async with pool.connection() as conn:
                rows = await (
                    await conn.execute(
                        claim_sql,
                        (
                            *params,
                            claim_limit,
                            ENRICHMENT_WORKER_ID,
                            str(ENRICHMENT_LEASE_SECONDS),
                            run_id,
                        ),
                    )
                ).fetchall()
    candidates = [
        (
            str(r["id"]),
            str(r["canonicalUrl"]),
            str(r["originalKind"]),
            int(r.get("enrichmentAttempts") or 1),
            str(r.get("enrichmentClaimId") or run_id),
        )
        for r in rows
    ]
    if not candidates:
        return 0

    effective_item_timeout = None if item_timeout == 0 else item_timeout
    if effective_item_timeout is None and item_timeout != 0:
        try:
            effective_item_timeout = max(
                30.0,
                float(os.environ.get("RADAR_ENRICHMENT_ITEM_TIMEOUT_SECONDS", "600")),
            )
        except ValueError:
            effective_item_timeout = 600.0
    semaphore = asyncio.Semaphore(enrichment_concurrency)

    async def _mark_enrichment_retry(
        summary_id: str,
        *,
        attempts: int,
        claim_id: str,
        error_code: str,
        error_message: str,
    ) -> None:
        terminal = attempts >= ENRICHMENT_MAX_ATTEMPTS
        status = "manual" if terminal else "retryable"
        delay = _retry_delay_seconds(attempts)
        async with pool.connection() as conn:
            await conn.execute(
                'UPDATE "summaries" SET '
                '"enrichmentStatus" = %s, '
                '"enrichmentLockedBy" = NULL, '
                '"enrichmentLeaseExpiresAt" = NULL, '
                '"enrichmentHeartbeatAt" = NULL, '
                '"enrichmentClaimId" = NULL, '
                '"enrichmentNextRetryAt" = CASE WHEN %s THEN NULL '
                'ELSE now() + (%s || \' seconds\')::interval END, '
                '"enrichmentErrorCode" = %s, '
                '"enrichmentErrorMessage" = %s, '
                '"updatedAt" = now() '
                'WHERE "id" = %s AND "enrichmentLockedBy" = %s '
                'AND "enrichmentClaimId" = %s::uuid '
                'AND "enrichmentStatus" = \'running\'',
                (
                    status,
                    terminal,
                    str(delay),
                    error_code[:64],
                    error_message[:500],
                    summary_id,
                    ENRICHMENT_WORKER_ID,
                    claim_id,
                ),
            )

    async def _mark_enrichment_success(
        summary_id: str,
        *,
        attempts: int,
        claim_id: str,
        retryable: bool,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        terminal = retryable and attempts >= ENRICHMENT_MAX_ATTEMPTS
        delay = _retry_delay_seconds(attempts)
        async with pool.connection() as conn:
            await conn.execute(
                'UPDATE "summaries" SET '
                '"enrichmentStatus" = CASE WHEN "distilledTier" IN '
                '(\'collection\', \'deep_read\') THEN %s ELSE NULL END, '
                '"enrichmentLockedBy" = NULL, '
                '"enrichmentLeaseExpiresAt" = NULL, '
                '"enrichmentHeartbeatAt" = NULL, '
                '"enrichmentClaimId" = NULL, '
                '"enrichmentNextRetryAt" = CASE WHEN "distilledTier" IN '
                '(\'collection\', \'deep_read\') AND %s THEN '
                'now() + (%s || \' seconds\')::interval ELSE NULL END, '
                '"enrichmentErrorCode" = %s, '
                '"enrichmentErrorMessage" = %s, '
                '"updatedAt" = now() '
                'WHERE "id" = %s AND "enrichmentLockedBy" = %s '
                'AND "enrichmentClaimId" = %s::uuid '
                'AND "enrichmentStatus" = \'running\'',
                (
                    "manual" if terminal else ("retryable" if retryable else "ready"),
                    retryable and not terminal,
                    str(delay),
                    error_code[:64] if error_code else None,
                    error_message[:500] if error_message else None,
                    summary_id,
                    ENRICHMENT_WORKER_ID,
                    claim_id,
                ),
            )

    async def _heartbeat(summary_id: str, claim_id: str) -> None:
        interval = ENRICHMENT_HEARTBEAT_SECONDS
        while True:
            await asyncio.sleep(interval)
            async with pool.connection() as conn:
                await conn.execute(
                    'UPDATE "summaries" SET '
                    '"enrichmentHeartbeatAt" = now(), '
                    '"enrichmentLeaseExpiresAt" = now() + (%s || \' seconds\')::interval '
                    'WHERE "id" = %s AND "enrichmentLockedBy" = %s '
                    'AND "enrichmentClaimId" = %s::uuid '
                    'AND "enrichmentStatus" = \'running\'',
                    (
                        str(ENRICHMENT_LEASE_SECONDS),
                        summary_id,
                        ENRICHMENT_WORKER_ID,
                        claim_id,
                    ),
                )

    async def _enrich_one(
        summary_id: str,
        url: str,
        kind: str,
        attempts: int,
        claim_id: str,
    ) -> bool:
        async with semaphore:
            heartbeat_task = asyncio.create_task(_heartbeat(summary_id, claim_id))
            try:
                payload: dict[str, Any] | None = None
                if kind == "github_repo":
                    payload = await enrich_github_candidate(
                        pool,
                        summary_id=summary_id,
                        canonical_url=url,
                        force=force,
                        lease_owner=ENRICHMENT_WORKER_ID,
                        claim_id=claim_id,
                    )
                elif kind == "arxiv":
                    payload = await enrich_arxiv_candidate(
                        pool,
                        summary_id=summary_id,
                        canonical_url=url,
                        lease_owner=ENRICHMENT_WORKER_ID,
                        claim_id=claim_id,
                    )
                elif kind in ("github_other", "github_issue", "github_pr", "github_release"):
                    # GitHub "other" includes blob/docs links shared by HN
                    # and other feeds.  Only issue/PR/release URLs can use
                    # the GitHub item API; arbitrary GitHub pages must use the
                    # normal article extractor instead of being dropped as an
                    # unparseable item forever.
                    if _parse_github_item_url(url) is not None:
                        payload = await enrich_github_item_candidate(
                            pool,
                            summary_id=summary_id,
                            canonical_url=url,
                            lease_owner=ENRICHMENT_WORKER_ID,
                            claim_id=claim_id,
                        )
                    else:
                        payload = await enrich_web_candidate(
                            pool,
                            summary_id=summary_id,
                            canonical_url=url,
                            lease_owner=ENRICHMENT_WORKER_ID,
                            claim_id=claim_id,
                        )
                elif kind in ("rss", "web_share"):
                    if force:
                        payload = await enrich_web_candidate(
                            pool,
                            summary_id=summary_id,
                            canonical_url=url,
                            force=True,
                            lease_owner=ENRICHMENT_WORKER_ID,
                            claim_id=claim_id,
                        )
                    else:
                        payload = await enrich_web_candidate(
                            pool,
                            summary_id=summary_id,
                            canonical_url=url,
                            lease_owner=ENRICHMENT_WORKER_ID,
                            claim_id=claim_id,
                        )
                await _assert_enrichment_lease(
                    pool,
                    summary_id=summary_id,
                    lease_owner=ENRICHMENT_WORKER_ID,
                    claim_id=claim_id,
                )
                if payload is None and kind in ("rss", "web_share", "github_other"):
                    await _downgrade_empty_web_candidate(
                        pool,
                        summary_id,
                        lease_owner=ENRICHMENT_WORKER_ID,
                        claim_id=claim_id,
                    )
                source_retryable = payload is None
                source_error_code = "ENRICHMENT_EMPTY_RESULT" if payload is None else None
                source_error_message = (
                    "source enrichment returned no usable payload"
                    if payload is None else None
                )
                if kind == "github_repo" and isinstance(payload, dict):
                    zread = payload.get("zread")
                    if not _zread_pages_complete(zread):
                        source_retryable = True
                        source_error_code = "ZREAD_INCOMPLETE"
                        source_error_message = "Zread document is partial or failed"
                finalization: dict[str, Any] = {}
                try:
                    # Source writes are claim-guarded, but review
                    # reconciliation is a separate state machine. Re-check
                    # immediately before and after it so a reclaimed lease
                    # cannot continue into review/final status transitions.
                    await _assert_enrichment_lease(
                        pool,
                        summary_id=summary_id,
                        lease_owner=ENRICHMENT_WORKER_ID,
                        claim_id=claim_id,
                    )
                    finalization = await finalize_enrichment(
                        pool,
                        summary_id=summary_id,
                        # A normal write invalidates the old review state in
                        # the same SQL transaction. Explicit force is only
                        # needed for a caller that deliberately refreshed the
                        # snapshot.
                        force_review=bool(payload and force),
                    )
                    await _assert_enrichment_lease(
                        pool,
                        summary_id=summary_id,
                        lease_owner=ENRICHMENT_WORKER_ID,
                        claim_id=claim_id,
                    )
                    if finalization.get("quality_status") in {"incomplete", "invalid"}:
                        source_retryable = True
                        source_error_code = source_error_code or "READER_QUALITY_INCOMPLETE"
                        source_error_message = (
                            source_error_message
                            or "reader quality contract is incomplete"
                        )
                except EnrichmentLeaseLost:
                    raise
                except Exception:
                    # The source snapshot is already durable. Review
                    # reconciliation can repair a missing quality/content
                    # handoff without forcing another expensive source fetch.
                    logger.warning(
                        "ai-engine.radar.enrichment.finalization_failed",
                        extra={"summary_id": summary_id},
                        exc_info=True,
                    )
                await _mark_enrichment_success(
                    summary_id,
                    attempts=attempts,
                    claim_id=claim_id,
                    retryable=source_retryable,
                    error_code=source_error_code,
                    error_message=source_error_message,
                )
                review = finalization.get("review")
                if review is None:
                    logger.info(
                        "ai-engine.radar.enrichment.review_claim_skipped",
                        extra={"summary_id": summary_id},
                    )
                elif review["content_status"] == "needs_manual_review":
                    logger.warning(
                        "ai-engine.radar.enrichment.content_review_manual",
                        extra={
                            "summary_id": summary_id,
                            "quality_status": review["quality_status"],
                        },
                    )
                if review and review["render_queued"]:
                    logger.info(
                        "ai-engine.radar.enrichment.render_review_queued",
                        extra={"summary_id": summary_id},
                    )
                # A persisted partial/failed source is durable evidence for
                # diagnostics, not a successful enrichment. Keep it out of
                # this count so callers do not rescore or report an incomplete
                # reader snapshot as completed work.
                return bool(payload) and not source_retryable
            except Exception as exc:
                await _mark_enrichment_retry(
                    summary_id,
                    attempts=attempts,
                    claim_id=claim_id,
                    error_code=type(exc).__name__,
                    error_message=str(exc),
                )
                logger.warning(
                    "ai-engine.radar.enrichment.candidate_exception",
                    extra={
                        "summary_id": summary_id,
                        "url": url,
                        "kind": kind,
                        "error": type(exc).__name__,
                    },
                )
                return False
            finally:
                heartbeat_task.cancel()
                await asyncio.gather(heartbeat_task, return_exceptions=True)

    async def _bounded_enrich(
        summary_id: str,
        url: str,
        kind: str,
        attempts: int,
        claim_id: str,
    ) -> bool:
        try:
            if effective_item_timeout is None:
                return await _enrich_one(
                    summary_id,
                    url,
                    kind,
                    attempts,
                    claim_id,
                )
            return await asyncio.wait_for(
                _enrich_one(summary_id, url, kind, attempts, claim_id),
                timeout=effective_item_timeout,
            )
        except asyncio.TimeoutError:
            await _mark_enrichment_retry(
                summary_id,
                attempts=attempts,
                claim_id=claim_id,
                error_code="ENRICHMENT_TIMEOUT",
                error_message=f"item exceeded {effective_item_timeout:.0f}s timeout",
            )
            logger.warning(
                "ai-engine.radar.enrichment.item_timeout",
                extra={
                    "summary_id": summary_id,
                    "kind": kind,
                    "timeout_seconds": effective_item_timeout,
                },
            )
            return False

    outcomes = await asyncio.gather(
        *(
            _bounded_enrich(summary_id, url, kind, attempts, claim_id)
            for summary_id, url, kind, attempts, claim_id in candidates
        )
    )
    succeeded = sum(outcomes)
    attempted = len(candidates)
    if attempted < claim_limit or attempted >= limit:
        return succeeded

    # Never claim more rows than can be actively heartbeated. Continue in a
    # fresh bounded batch so a serial CLI run cannot leave waiting rows with
    # expired leases. Explicit force runs must provide summary_ids; remove the
    # completed ids before the next batch so a forced repair cannot reselect
    # its own completed work.
    remaining_summary_ids = summary_ids
    if summary_ids:
        completed_ids = {summary_id for summary_id, *_ in candidates}
        remaining_summary_ids = tuple(
            summary_id for summary_id in summary_ids
            if summary_id not in completed_ids
        )
        if not remaining_summary_ids:
            return succeeded
    elif force:
        return succeeded

    return succeeded + await _run_enrichment_for_pending(
        pool,
        limit=limit - attempted,
        source_kinds=source_kinds,
        sync_run_ids=sync_run_ids,
        summary_ids=remaining_summary_ids,
        concurrency=enrichment_concurrency,
        force=force,
        item_timeout=item_timeout,
        run_id=run_id,
    )


async def run_enrichment_for_pending(
    pool: Any,
    *,
    limit: int = 50,
    source_kinds: tuple[str, ...] = DEFAULT_ENRICHMENT_KINDS,
    sync_run_ids: tuple[str, ...] | None = None,
    summary_ids: tuple[str, ...] | None = None,
    concurrency: int | None = None,
    force: bool = False,
    item_timeout: float | None = None,
    run_id: str | None = None,
) -> int:
    """Claim and process durable enrichment work.

    The advisory lock is acquired only around the short database claim inside
    ``_run_enrichment_for_pending``. Long-running source fetches use the
    per-row lease and claim token, so an unrelated new candidate does not wait
    behind a slow Zread job.
    """
    return await _run_enrichment_for_pending(
        pool,
        limit=limit,
        source_kinds=source_kinds,
        sync_run_ids=sync_run_ids,
        summary_ids=summary_ids,
        concurrency=concurrency,
        force=force,
        item_timeout=item_timeout,
        run_id=run_id,
    )


@asynccontextmanager
async def _cross_process_enrichment_lock(pool: Any) -> AsyncIterator[bool]:
    """Hold the shared PostgreSQL lock for one enrichment dispatch.

    The lock connection must remain checked out for the entire duration:
    advisory locks belong to a database session, not to a transaction or a
    pool object.  Fail closed if the lock cannot be acquired or verified;
    running duplicate Zread jobs is more harmful than deferring one retry.
    """
    connection_cm = pool.connection()
    try:
        lock_conn = await connection_cm.__aenter__()
    except Exception:
        logger.exception(
            "ai-engine.radar.enrichment.lock_connection_failed",
        )
        yield False
        return

    try:
        try:
            cursor = await lock_conn.execute(
                "SELECT pg_try_advisory_lock(%s, %s) AS acquired",
                _ENRICHMENT_ADVISORY_LOCK_KEYS,
            )
            row = await cursor.fetchone()
            if isinstance(row, dict):
                acquired = bool(row.get("acquired"))
            elif row:
                acquired = bool(row[0])
            else:
                acquired = False
        except Exception:
            logger.exception(
                "ai-engine.radar.enrichment.lock_check_failed",
            )
            yield False
            return

        if not acquired:
            logger.info(
                "ai-engine.radar.enrichment.lock_busy",
            )
            yield False
            return

        try:
            # Let exceptions from the work performed under the lock propagate
            # unchanged. Catching them in the outer context manager and
            # yielding a second time produces the opaque
            # "generator didn't stop after athrow()" failure.
            yield True
        finally:
            try:
                await lock_conn.execute(
                    "SELECT pg_advisory_unlock(%s, %s)",
                    _ENRICHMENT_ADVISORY_LOCK_KEYS,
                )
            except Exception:
                # The connection is about to return to the pool; keep
                # the failure visible, but do not mask the worker result.
                logger.exception(
                    "ai-engine.radar.enrichment.lock_release_failed",
                )
    finally:
        try:
            await connection_cm.__aexit__(None, None, None)
        except Exception:
            logger.exception(
                "ai-engine.radar.enrichment.lock_connection_close_failed",
            )


async def _generate_web_highlights(
    markdown: str, title: str,
) -> dict[str, Any] | None:
    """Use BRIEF_LLM to extract key highlights from a web article.

    Returns a dict with:
      - highlights: list of 3-5 key bullet points (each ≤ 100 chars)
      - summary: one-sentence TL;DR (≤ 150 chars)
      - key_quote: one notable quote from the article (≤ 300 chars), or null

    Returns None on failure; caller silently falls back.
    """
    import json as _json

    def _clip(value: Any, limit: int, *, sentence: bool = False) -> str:
        """Keep generated text readable when the model exceeds its limit."""
        text = str(value or "").strip()
        if len(text) <= limit:
            return text
        clipped = text[:limit]
        if sentence:
            boundaries = [clipped.rfind(mark) for mark in (".", "!", "?", "。", "！", "？")]
            boundary = max(boundaries)
            if boundary >= max(40, limit // 2):
                return clipped[: boundary + 1].strip()
        boundary = clipped.rfind(" ")
        return clipped[:boundary if boundary >= limit // 2 else limit].rstrip(" ,;:-")

    def _deterministic_fallback() -> dict[str, Any] | None:
        paragraphs = [
            _clip(part, 150, sentence=True)
            for part in _re.split(r"\n\s*\n", markdown)
            if len(part.strip()) >= 20 and not part.lstrip().startswith(("#", "```"))
        ]
        highlights = [part for part in paragraphs if part][:5]
        if len(highlights) < 3:
            return None
        return {
            "summary": _clip(highlights[0], 300, sentence=True),
            "highlights": highlights,
            "key_quote": _clip(highlights[0], 300, sentence=True) or None,
            "fallback": True,
        }

    llm_spec = resolve_spec("utility")

    system_prompt = (
        "You are a professional article analyst. "
        "Extract the most important points concisely. "
        "Do not fabricate. Output language: simplified Chinese."
    )
    user_prompt = (
        f"标题: {title}\n\n"
        f"正文 (前 12000 字):\n{markdown[:12000]}\n\n"
        "请按以下 JSON 格式输出 (不要 markdown 代码块、不要多余解释):\n"
        "{\n"
        '  "summary": "一句话总结全文，不超过 150 字",\n'
        '  "highlights": ["亮点 1 (≤ 100 字)", "亮点 2", "亮点 3", "亮点 4", "亮点 5"],\n'
        '  "key_quote": "原文中最有启发性的一句话 (≤ 300 字)，如果没有则填 null"\n'
        "}\n"
        "要求：highlights 至少 3 条，最多 5 条。"
    )

    try:
        result = await generate_text(
            llm_spec=llm_spec,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=2048,
            disable_thinking=True,
            operation="radar.enrichment.article_highlights",
        )
        body = result.text
        # Extract JSON from response (handle potential markdown fences)
        if "```json" in body:
            body = body.split("```json", 1)[1]
            if "```" in body:
                body = body.split("```", 1)[0]
        elif "```" in body:
            body = body.split("```", 1)[1]
            if "```" in body:
                body = body.split("```", 1)[0]
        parsed = _json.loads(body.strip())
        if not isinstance(parsed, dict):
            return None
        return {
            "summary": _clip(parsed.get("summary", ""), 300, sentence=True),
            "highlights": [_clip(h, 150, sentence=True) for h in (parsed.get("highlights") or [])][:5],
            "key_quote": _clip(parsed.get("key_quote"), 300, sentence=True) or None,
        }
    except Exception as exc:
        logger.debug(
            "ai-engine.radar.enrichment.web_highlights_llm_error",
            extra={"title": title[:80], "error": type(exc).__name__},
        )
        return _deterministic_fallback()
