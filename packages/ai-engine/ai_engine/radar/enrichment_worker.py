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
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit

import httpx

from ai_engine.fetcher.safe_fetch import safe_fetch
from ai_engine.llm.client import generate_text
from ai_engine.llm.config import resolve_spec
from ai_engine.radar.distilled_scorer import _parse_llm_response

logger = logging.getLogger("ai_engine.radar.enrichment_worker")

# A sync run and a detail-page retry may share the same process and database.
# The process-local lock below protects the common in-process case.  The
# PostgreSQL advisory lock in ``_cross_process_enrichment_lock`` protects the
# more important case where a manual script and uvicorn run in different
# processes.
_ENRICHMENT_RUN_LOCK = asyncio.Lock()
_ENRICHMENT_ADVISORY_LOCK_KEYS = (2147483629, 20260827)

# Cap tree nodes to keep payloads bounded; 200 is the gpt-researcher
# recommendation and matches Phase 2A design.
TREE_NODE_MAX = 200
# Cap JSONB payload to ~16KB (well under Postgres TOAST).
ORIGINAL_META_MAX_BYTES = 16_000
README_MAX_CHARS = 120_000
# Inline SVG figures are base64-encoded for the safe Markdown renderer. Keep
# enough room for a full paper plus its vector figures; generic web content
# retains the smaller limit in sync_runner.
ARXIV_MARKDOWN_MAX_BYTES = 512 * 1024
ENRICHMENT_VERSION = "2.0"
GITHUB_ENRICHMENT_RETRY_SECONDS = max(
    3_600,
    int(os.environ.get("RADAR_GITHUB_ENRICHMENT_RETRY_SECONDS", "7200")),
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
                '"originalMeta", "tldr", "highlights", "repoSummary" '
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
            "originalMarkdown", "originalMeta", "tldr", "highlights",
            "repoSummary",
        )
        return dict(zip(keys, row))


async def _downgrade_empty_web_candidate(pool: Any, summary_id: str) -> None:
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
        await conn.execute(
            'UPDATE "summaries" SET '
            '"distilledTier" = \'skim\', '
            '"distilledMustRead" = false, '
            '"tags" = CASE WHEN \'content_pending\' = ANY('
            'COALESCE("tags", ARRAY[]::text[])) THEN "tags" '
            'ELSE array_append(COALESCE("tags", ARRAY[]::text[]), '
            '\'content_pending\') END, '
            '"updatedAt" = now() WHERE "id" = %s',
            (summary_id,),
        )


async def enrich_github_item_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
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
        await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMarkdown" = %s, '
            '"originalMeta" = %s::jsonb, '
            '"originalSha256" = %s, '
            '"originalBytes" = %s, '
            '"tldr" = COALESCE("tldr", %s), '
            '"updatedAt" = now() '
            'WHERE "id" = %s',
            (
                markdown,
                json.dumps(payload, ensure_ascii=False),
                hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
                len(markdown.encode("utf-8")),
                str(tldr)[:500] if tldr else None,
                summary_id,
            ),
        )
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


async def enrich_web_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
    force: bool = False,
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
    ):
        return dict(existing_meta)

    doc = None
    try:
        doc = await safe_fetch(canonical_url, timeout=15.0)
    except Exception:
        if not existing_markdown or _is_low_quality_content(existing_markdown):
            return None

    fetched_markdown = ""
    if doc is not None:
        html = doc.content.decode("utf-8", errors="replace")
        fetched_markdown = _strip_nul(
            _extract_article_content(html, canonical_url, "web")
        )
        fetched_markdown = fetched_markdown[:ARXIV_MARKDOWN_MAX_BYTES]

    new_markdown = existing_markdown
    if fetched_markdown and not _is_low_quality_content(fetched_markdown):
        if (
            not existing_markdown.strip()
            or _is_low_quality_content(existing_markdown)
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
        await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMeta" = %s::jsonb, '
            '"originalMarkdown" = %s, '
            '"originalSha256" = %s, '
            '"originalBytes" = %s, '
            '"originalFetchedAt" = now(), '
            '"tldr" = COALESCE("tldr", %s), '
            '"highlights" = %s::jsonb, '
            '"updatedAt" = now() '
            'WHERE "id" = %s',
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
            ),
        )
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
    return markdown[:ARXIV_MARKDOWN_MAX_BYTES]


async def enrich_github_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
    force: bool = False,
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
    zread_payload = existing_zread if (
        not force
        and
        isinstance(existing_zread, dict)
        and (
            existing_zread.get("provider") == "zread-remote"
            and existing_zread.get("repoHeadSha") == head_sha
            and existing_zread.get("commitSha")
            and existing_zread.get("parserVersion") == 4
        )
        and isinstance(existing_zread.get("pages"), list)
        and (
            existing_zread.get("status") == "complete"
            or (
                int(existing_zread.get("pageCount") or 0)
                >= int(existing_zread.get("expectedPageCount") or 0)
            )
        )
    ) else None
    # Remote retrieval and local generation are separate providers. Disabling
    # the CLI must never disable fetching an already-published Zread wiki.
    zread_cli_enabled = os.environ.get("ZREAD_CLI_ENABLED", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }
    if zread_payload is None:
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
    remote_page_count = int((remote_payload or {}).get("pageCount") or 0)
    remote_expected_page_count = int((remote_payload or {}).get("expectedPageCount") or 0)
    remote_complete = bool(
        remote_payload
        and (
            remote_payload.get("status") == "complete"
            or (
                remote_page_count > 0
                and remote_page_count >= remote_expected_page_count
            )
        )
    )
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

    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMeta" = %s::jsonb, '
            '"originalMarkdown" = %s, '
            '"originalSha256" = %s, '
            '"originalBytes" = %s, '
            '"originalFetchedAt" = now(), '
            '"repoSummary" = %s, '
            '"updatedAt" = now() '
            'WHERE "id" = %s',
            (
                json.dumps(payload, ensure_ascii=False),
                scoring_markdown or None,
                hashlib.sha256(markdown_bytes).hexdigest() if markdown_bytes else None,
                len(markdown_bytes) or None,
                repo_summary,
                summary_id,
            ),
        )
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
        [],
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
                'SELECT "title" FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
        if title_row is None:
            title = arxiv_id
        else:
            # pool.connection() may return dict_row (mapping) or tuple
            try:
                title = str(title_row["title"])  # dict-like
            except (TypeError, KeyError):
                title = str(title_row[0])  # tuple-like

    analysis = await _generate_arxiv_analysis(markdown, title)
    tldr_text: str | None = analysis.get("tldr") if analysis else None

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
    }
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMarkdown" = %s, '
            '"originalMeta" = %s::jsonb, '
            '"sections" = %s::jsonb, '
            '"tldr" = %s, '
            '"arxivAnalysis" = %s::jsonb, '
            '"authors" = %s, '
            '"figures" = %s::jsonb, '
            '"originalBytes" = %s, '
            '"originalFetchedAt" = now(), '
            '"updatedAt" = now() '
            'WHERE "id" = %s',
            (
                markdown,
                json.dumps(meta_payload, ensure_ascii=False),
                json.dumps(sections, ensure_ascii=False),
                tldr_text,
                json.dumps(analysis, ensure_ascii=False) if analysis else None,
                authors[:30],  # cap to top 30 authors (most arxiv papers fit)
                json.dumps(figures, ensure_ascii=False),
                len(markdown.encode("utf-8")),
                summary_id,
            ),
        )
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
        await conn.execute(
            'UPDATE "summaries" SET "originalMeta" = %s::jsonb, '
            '"tldr" = COALESCE("tldr", %s), '
            '"arxivAnalysis" = COALESCE("arxivAnalysis", %s::jsonb), '
            '"originalBytes" = COALESCE("originalBytes", %s), '
            '"originalFetchedAt" = COALESCE("originalFetchedAt", now()), '
            '"updatedAt" = now() WHERE "id" = %s',
            (
                json.dumps(meta_payload, ensure_ascii=False),
                tldr or None,
                json.dumps(analysis, ensure_ascii=False) if analysis else None,
                len(markdown.encode("utf-8")),
                summary_id,
            ),
        )
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
    enrichment_need = (
        'TRUE '
        if force
        else '((("originalKind" IN (\'rss\', \'web_share\')) AND ('
             '"highlights" IS NULL OR '
             'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\')) '
             # GitHub sync can persist a lightweight repository snapshot before
             # the deep enrichment stage.  Do not mistake that snapshot for a
             # completed enrichment: it has no v2 marker and no Zread pages.
             'OR ("originalKind" = \'github_repo\' '
             'AND "canonicalUrl" NOT LIKE \'%%digest=%%\' AND ('
             '"originalMeta" IS NULL '
             'OR COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\' '
             'OR COALESCE("originalMeta"->\'zread\'->>\'status\', \'\') '
             'NOT IN (\'complete\', \'partial\', \'failed\') '
             # A README fallback is deliberately marked partial even though
             # it contains one readable page.  It must remain retryable;
             # otherwise pageCount=expectedPageCount=1 makes the fallback
             # permanently mask a missing Zread wiki.  The same retry rule
             # applies to any partial result so an unpublished draft can
             # eventually be promoted to a complete document.
             'OR (COALESCE("originalMeta"->\'zread\'->>\'status\', \'\') = \'partial\' '
             'AND COALESCE(NULLIF("originalMeta"->\'zread\'->>\'generatedAt\', \'\')::timestamptz, '
             'to_timestamp(0)) < now() - '
             f'make_interval(secs => {GITHUB_ENRICHMENT_RETRY_SECONDS})) '
             'OR (COALESCE("originalMeta"->\'zread\'->>\'status\', \'\') = \'failed\' '
             'AND COALESCE(NULLIF("originalMeta"->\'zread\'->>\'generatedAt\', \'\')::timestamptz, '
             'to_timestamp(0)) < now() - '
             f'make_interval(secs => {GITHUB_ENRICHMENT_RETRY_SECONDS}))'
             ')) '
             'OR ("originalKind" = \'arxiv\' AND ('
             '"arxivAnalysis" IS NULL OR "tldr" IS NULL OR '
             'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\')) '
             'OR ("originalKind" IN (\'github_other\', \'github_release\') AND ('
             '"originalMeta" IS NULL OR '
             'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\')) '
             'OR ("originalKind" NOT IN (\'rss\', \'web_share\', \'github_repo\') '
             'AND "originalMeta" IS NULL)) '
    )
    # Distilled scoring already decided the reading depth.  Enrichment is a
    # deeper, more expensive representation and must not run for skim/noise
    # rows. Explicit --summary-id repairs retain the force escape hatch.
    tier_filter = (
        'TRUE' if force
        else '"distilledTier" IN (\'collection\', \'deep_read\')'
    )
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id", "canonicalUrl", "originalKind" FROM "summaries" '
                f'WHERE "originalKind" IN ({placeholders}) '
                f'AND {tier_filter} '
                f'AND {enrichment_need}'
                'AND NOT ("originalKind" = \'github_repo\' AND '
                'COALESCE("tags", ARRAY[]::text[]) '
                '@> ARRAY[\'repo_digest\']::text[]) '
                'AND ("source" = \'daily\' OR "syncRunId" IS NOT NULL OR EXISTS ('
                'SELECT 1 FROM "share_submissions" sh '
                'WHERE sh."publishedSummaryId" = "summaries"."id" '
                'AND sh."status" = \'approved\')) '
                f"{summary_filter}"
                f"{run_filter}"
                'ORDER BY "createdAt" DESC LIMIT %s',
                (*params, limit),
            )
        ).fetchall()
    candidates = [
        (str(r["id"]), str(r["canonicalUrl"]), str(r["originalKind"]))
        for r in rows
    ]
    if not candidates:
        return 0

    enrichment_concurrency = max(
        1,
        concurrency
        or int(os.environ.get("RADAR_ENRICHMENT_CONCURRENCY", "2")),
    )
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

    async def _enrich_one(summary_id: str, url: str, kind: str) -> bool:
        async with semaphore:
            try:
                payload: dict[str, Any] | None = None
                if kind == "github_repo":
                    payload = await enrich_github_candidate(
                        pool,
                        summary_id=summary_id,
                        canonical_url=url,
                        force=force,
                    )
                elif kind == "arxiv":
                    payload = await enrich_arxiv_candidate(
                        pool, summary_id=summary_id, canonical_url=url,
                    )
                elif kind in ("github_other", "github_release"):
                    # GitHub "other" includes blob/docs links shared by HN
                    # and other feeds.  Only issue/PR/release URLs can use
                    # the GitHub item API; arbitrary GitHub pages must use the
                    # normal article extractor instead of being dropped as an
                    # unparseable item forever.
                    if _parse_github_item_url(url) is not None:
                        payload = await enrich_github_item_candidate(
                            pool, summary_id=summary_id, canonical_url=url,
                        )
                    else:
                        payload = await enrich_web_candidate(
                            pool, summary_id=summary_id, canonical_url=url,
                        )
                elif kind in ("rss", "web_share"):
                    if force:
                        payload = await enrich_web_candidate(
                            pool, summary_id=summary_id, canonical_url=url, force=True,
                        )
                    else:
                        payload = await enrich_web_candidate(
                            pool, summary_id=summary_id, canonical_url=url,
                        )
                if payload is None and kind in ("rss", "web_share", "github_other"):
                    await _downgrade_empty_web_candidate(pool, summary_id)
                if payload:
                    async with pool.connection() as conn:
                        await conn.execute(
                            'UPDATE "summaries" SET "tags" = array_remove('
                            'array_remove("tags", \'content_pending\'), '
                            '\'github_content_pending\'), "updatedAt" = now() '
                            'WHERE "id" = %s',
                            (summary_id,),
                        )
                        commit = getattr(conn, "commit", None)
                        if commit is not None:
                            await commit()
                return bool(payload)
            except Exception as exc:
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

    async def _bounded_enrich(summary_id: str, url: str, kind: str) -> bool:
        try:
            if effective_item_timeout is None:
                return await _enrich_one(summary_id, url, kind)
            return await asyncio.wait_for(
                _enrich_one(summary_id, url, kind),
                timeout=effective_item_timeout,
            )
        except asyncio.TimeoutError:
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
        *(_bounded_enrich(summary_id, url, kind) for summary_id, url, kind in candidates)
    )
    return sum(outcomes)


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
) -> int:
    """Serialize enrichment dispatch across processes and within one process.

    A PostgreSQL session-level advisory lock is held for the full dispatch.
    ``pg_try_advisory_lock`` is intentionally non-blocking: an overlapping
    caller returns zero and the scheduler/manual caller can retry later,
    rather than starting a second expensive Zread generation.
    """
    async with _ENRICHMENT_RUN_LOCK:
        async with _cross_process_enrichment_lock(pool) as acquired:
            if not acquired:
                return 0
            return await _run_enrichment_for_pending(
                pool,
                limit=limit,
                source_kinds=source_kinds,
                sync_run_ids=sync_run_ids,
                summary_ids=summary_ids,
                concurrency=concurrency,
                force=force,
                item_timeout=item_timeout,
            )


@asynccontextmanager
async def _cross_process_enrichment_lock(pool: Any) -> AsyncIterator[bool]:
    """Hold the shared PostgreSQL lock for one enrichment dispatch.

    The lock connection must remain checked out for the entire duration:
    advisory locks belong to a database session, not to a transaction or a
    pool object.  Fail closed if the lock cannot be acquired or verified;
    running duplicate Zread jobs is more harmful than deferring one retry.
    """
    try:
        async with pool.connection() as lock_conn:
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
    except Exception:
        logger.exception(
            "ai-engine.radar.enrichment.lock_connection_failed",
        )
        yield False


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
