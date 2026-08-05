"""Radar deep-dive enrichment worker.

Phase 2A: enrich GitHub repo candidates with file tree + entry points +
repo metadata by calling GitHub's REST API.
Phase 2B: enrich arxiv paper candidates with PDF-parsed structure
(sections + figures) + LLM-generated TL;DR.

Design points:
- Failures are isolated per candidate; one repo's 404/timeout does not
  block the rest of the batch.
- When ``GH_TOKEN`` is unset we degrade gracefully — skip the tree call,
  log a warning, and let the next sync attempt retry (no crash).
- We never call ``safe_fetch`` against api.github.com: HTTPS+443 + JSON
  content-type is already in the allow-list; using httpx directly keeps
  the failure modes easy to read.
- arxiv PDF fetch goes through ``safe_fetch`` (SSRF defense is required
  for arbitrary URLs). pymupdf parses the PDF inline; figures are
  extracted but not persisted as base64 in P0 (only metadata).
- Output JSON shape is intentionally small (≤16KB) so Postgres TOAST
  isn't triggered and the BFF can ship it inline.
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
from typing import Any
from urllib.parse import quote, unquote, urlsplit

import httpx

from ai_engine.fetcher.safe_fetch import safe_fetch
from ai_engine.llm.client import generate_text

logger = logging.getLogger("ai_engine.radar.enrichment_worker")

# Cap tree nodes to keep payloads bounded; 200 is the gpt-researcher
# recommendation and matches Phase 2A design.
TREE_NODE_MAX = 200
# Cap JSONB payload to ~16KB (well under Postgres TOAST).
ORIGINAL_META_MAX_BYTES = 16_000

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
                '"originalMeta", "tldr" FROM "summaries" WHERE "id" = %s',
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
            "originalMarkdown", "originalMeta", "tldr",
        )
        return dict(zip(keys, row))


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

    current = await _fetch_enrichment_row(pool, summary_id)
    if not current:
        return None
    existing_markdown = _strip_nul(str(current.get("originalMarkdown") or ""))
    existing_meta = current.get("originalMeta")
    if isinstance(existing_meta, dict) and existing_meta.get("provider") == "web":
        return dict(existing_meta)

    try:
        doc = await safe_fetch(canonical_url, timeout=15.0)
    except Exception:
        # Leave the row retryable: sync already stored whatever markdown it
        # could, so a failed enrichment must not poison the candidate.
        return None

    html = doc.content.decode("utf-8", errors="replace")
    fetched_markdown = _strip_nul(
        _extract_article_content(html, canonical_url, "web")
    )
    fetched_markdown = fetched_markdown[: 64 * 1024]

    new_markdown = existing_markdown
    if fetched_markdown and not _is_low_quality_content(fetched_markdown):
        if (
            not existing_markdown.strip()
            or _is_low_quality_content(existing_markdown)
        ):
            new_markdown = fetched_markdown

    payload = {
        "provider": "web",
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "finalUrl": doc.url,
        "finalIp": doc.final_ip,
        "status": doc.status,
        "contentType": doc.content_type,
        "title": str(current.get("title") or "")[:300],
    }
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
            "status": doc.status,
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
        "lastPushedAt": data.get("pushed_at"),
        "description": data.get("description"),
    }


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
    base64-encoded markdown. Decoded + truncated to 8KB before being fed
    to the LLM — enough for module grouping, doesn't blow context.
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
        return decoded[:8192]
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


async def enrich_github_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
) -> dict[str, Any] | None:
    """Enrich one GitHub repo candidate; returns the persisted meta or None.

    Returns None when the URL isn't a repo URL or enrichment failed.
    Caller is responsible for catching all exceptions (we log + return None).
    """
    parsed = _parse_repo_path(canonical_url)
    if not parsed:
        return None
    owner, repo = parsed

    async with httpx.AsyncClient() as client:
        repo_meta = await _fetch_repo_meta(client, owner, repo)
        default_branch = (repo_meta or {}).get("defaultBranch") or "main"
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

    # Phase 2D: AI-written summary (500 words, styled after deepwiki.com's
    # Overview + What Is sections). Best-effort, doesn't break meta write.
    repo_summary: str | None = None
    if readme_text:
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

    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMeta" = %s::jsonb, '
            '"repoSummary" = %s, '
            '"updatedAt" = now() '
            'WHERE "id" = %s',
            (
                json.dumps(payload, ensure_ascii=False),
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
            "payload_bytes": len(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
        },
    )
    return payload


# ─────────────────────────────────────────────────────────────────────
# Phase 2B — arxiv PDF enrichment
# ─────────────────────────────────────────────────────────────────────


_ARXIV_ID_RE = _re_arxiv.compile(
    r"(?:arxiv\.org/(?:abs|pdf)/|abs/)?([0-9]{4}\.[0-9]{4,6}(?:v[0-9]+)?)"
)


def _parse_arxiv_id(url: str) -> str | None:
    """Extract arxiv id like 2401.12345 from a paper URL."""
    m = _ARXIV_ID_RE.search(url or "")
    return m.group(1) if m else None


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

        # Stop at page 10 to bound parsing cost.
        if page_idx >= 9:
            body_parts.append("\n\n[后续 10+ 页内容已截断]")
            break

    doc.close()
    markdown = "\n\n".join(body_parts)
    if len(markdown) > 64 * 1024:
        markdown = markdown[: 64 * 1024]
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
    llm_spec = os.environ.get("BRIEF_LLM") or os.environ.get("SMART_LLM") or "anthropic:claude-haiku-4-5"

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
        )
        text = result.text
        if not text:
            logger.warning(
                "ai-engine.radar.enrichment.arxiv_analysis_empty",
                extra={"reason": "llm_returned_empty"},
            )
            return None
        # Find first {...} block if LLM wrapped JSON in prose.
        brace_start = text.find("{")
        brace_end = text.rfind("}")
        if brace_start != -1 and brace_end > brace_start:
            text = text[brace_start : brace_end + 1]
        try:
            parsed: dict[str, Any] = _json.loads(text)
        except _json.JSONDecodeError:
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
    llm_spec = os.environ.get("BRIEF_LLM") or os.environ.get("SMART_LLM") or "anthropic:claude-haiku-4-5"

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
        f"README:\n{readme[:4000]}\n\n"
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
    2. Fetch PDF via safe_fetch
    3. Parse with pymupdf → markdown + sections
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

    pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
    try:
        pdf_bytes = await _fetch_arxiv_pdf(pdf_url)
    except Exception as exc:
        logger.warning(
            "ai-engine.radar.enrichment.arxiv_pdf_fetch_failed",
            extra={"summary_id": summary_id, "arxiv_id": arxiv_id, "error": type(exc).__name__},
        )
        return None

    if len(pdf_bytes) > 8 * 1024 * 1024:
        logger.warning(
            "ai-engine.radar.enrichment.arxiv_pdf_too_large",
            extra={"summary_id": summary_id, "arxiv_id": arxiv_id, "bytes": len(pdf_bytes)},
        )
        return None

    markdown, sections, authors, figures = _parse_arxiv_pdf(pdf_bytes)
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


async def run_enrichment_for_pending(
    pool: Any,
    *,
    limit: int = 50,
    source_kinds: tuple[str, ...] = DEFAULT_ENRICHMENT_KINDS,
    sync_run_ids: tuple[str, ...] | None = None,
    concurrency: int | None = None,
) -> int:
    """Find candidates that need enrichment and process them.

    A candidate needs enrichment if:
    - ``originalKind`` matches one of ``source_kinds``
    - ``originalMeta`` is null (not yet enriched)
    - ``syncRunId`` is not null (came from a real sync)

    Dispatches by source kind to the right enricher (github → REST,
    arxiv → PDF parse + LLM TL;DR).

    Returns count of successfully enriched rows.
    """
    placeholders = ",".join(["%s"] * len(source_kinds))
    run_filter = ""
    params: tuple[Any, ...] = (*source_kinds,)
    if sync_run_ids:
        run_placeholders = ",".join(["%s"] * len(sync_run_ids))
        run_filter = f'AND "syncRunId" IN ({run_placeholders}) '
        params = (*params, *sync_run_ids)
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id", "canonicalUrl", "originalKind" FROM "summaries" '
                f'WHERE "originalKind" IN ({placeholders}) '
                'AND "originalMeta" IS NULL '
                'AND "syncRunId" IS NOT NULL '
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
    semaphore = asyncio.Semaphore(enrichment_concurrency)

    async def _enrich_one(summary_id: str, url: str, kind: str) -> bool:
        async with semaphore:
            try:
                payload: dict[str, Any] | None = None
                if kind == "github_repo":
                    payload = await enrich_github_candidate(
                        pool, summary_id=summary_id, canonical_url=url,
                    )
                elif kind == "arxiv":
                    payload = await enrich_arxiv_candidate(
                        pool, summary_id=summary_id, canonical_url=url,
                    )
                elif kind in ("github_other", "github_release"):
                    payload = await enrich_github_item_candidate(
                        pool, summary_id=summary_id, canonical_url=url,
                    )
                elif kind in ("rss", "web_share"):
                    payload = await enrich_web_candidate(
                        pool, summary_id=summary_id, canonical_url=url,
                    )
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

    outcomes = await asyncio.gather(
        *(_enrich_one(summary_id, url, kind) for summary_id, url, kind in candidates)
    )
    return sum(outcomes)


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

    llm_spec = os.environ.get("BRIEF_LLM") or os.environ.get("SMART_LLM") or "anthropic:claude-haiku-4-5"

    system_prompt = (
        "You are a professional article analyst. "
        "Extract the most important points concisely. "
        "Do not fabricate. Output language: simplified Chinese."
    )
    user_prompt = (
        f"标题: {title}\n\n"
        f"正文 (前 4000 字):\n{markdown[:4000]}\n\n"
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
        return None
