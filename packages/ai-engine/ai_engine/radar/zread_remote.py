"""Read already-generated public Zread pages before invoking the local CLI.

Zread currently server-renders the page as Next.js flight data. The response
contains the generated Markdown, page catalog, and indexed Git commit, so we
can reuse public documentation without cloning the repository or spending
another LLM generation budget. This adapter is intentionally best-effort;
callers still fall back to the local CLI and then GitHub README.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any

import httpx

ZREAD_REMOTE_MAX_BYTES = 120_000
ZREAD_REMOTE_MAX_PAGES = 24
ZREAD_REMOTE_CONCURRENCY = 4
_FLIGHT_STRING = re.compile(
    r'self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)'
)
_PAGE_LINK = re.compile(
    r'href=["\']/((?P<owner>[A-Za-z0-9_.-]+)/(?P<repo>[A-Za-z0-9_.-]+)/(?P<slug>[A-Za-z0-9][A-Za-z0-9_-]*))["\']'
)
_COMMIT = re.compile(r'"commit"\s*:\s*\{"hash"\s*:\s*"([0-9a-f]{7,64})"')


def _enabled() -> bool:
    return os.environ.get("ZREAD_REMOTE_ENABLED", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }


def _page_title(markdown: str, slug: str) -> str:
    match = re.search(r'^#\s+(.+?)\s*$', markdown, re.MULTILINE)
    if match:
        return match.group(1).strip()[:200]
    return slug.replace("-", " ").replace("_", " ").title()[:200]


def _flight_markdown(html: str) -> str | None:
    """Extract the longest Markdown flight-data chunk from a Zread page."""
    candidates: list[str] = []
    for match in _FLIGHT_STRING.finditer(html):
        try:
            value = json.loads(match.group(1))
        except (json.JSONDecodeError, TypeError):
            continue
        if "\nslug:" in value and "\n---" in value:
            start = value.find("---\n")
            if start >= 0:
                content = value[start + 4 :]
                # Remove the second frontmatter delimiter and optional blank
                # lines. The remaining body is the original Markdown.
                end = content.find("\n---\n")
                if end >= 0:
                    content = content[end + 5 :].lstrip()
                if content.strip():
                    candidates.append(content.strip())
    return max(candidates, key=len, default=None)


def _page_refs(html: str, owner: str, repo: str) -> list[str]:
    normalized = html.replace('\\"', '"')
    slugs: list[str] = []
    seen: set[str] = set()
    for match in _PAGE_LINK.finditer(normalized):
        if match.group("owner") != owner or match.group("repo") != repo:
            continue
        slug = match.group("slug")
        if slug not in seen:
            seen.add(slug)
            slugs.append(slug)
        if len(slugs) >= ZREAD_REMOTE_MAX_PAGES:
            break
    # The page catalog is also embedded as JSON in the Next.js flight stream;
    # it may not be rendered as hrefs in the raw response.
    if len(slugs) < ZREAD_REMOTE_MAX_PAGES:
        for slug in re.findall(r'"slug"\s*:\s*"([A-Za-z0-9][A-Za-z0-9_-]*)"', normalized):
            if slug not in seen:
                seen.add(slug)
                slugs.append(slug)
            if len(slugs) >= ZREAD_REMOTE_MAX_PAGES:
                break
    return slugs


async def _get(client: httpx.AsyncClient, url: str) -> str | None:
    try:
        response = await client.get(url)
        response.raise_for_status()
    except (httpx.HTTPError, OSError):
        return None
    if not response.text:
        return None
    return response.text


async def fetch_zread_wiki(
    *,
    owner: str,
    repo: str,
) -> dict[str, Any] | None:
    """Fetch public Zread Markdown pages, returning None when unavailable."""
    if not _enabled():
        return None
    base_url = f"https://zread.ai/{owner}/{repo}"
    headers = {"User-Agent": "deep-research-zread-reader/1.0"}
    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(20.0, connect=8.0),
        headers=headers,
    ) as client:
        root_html = await _get(client, base_url)
        if not root_html:
            return None
        commit_match = _COMMIT.search(root_html.replace('\\"', '"'))
        indexed_commit = commit_match.group(1) if commit_match else None
        slugs = _page_refs(root_html, owner, repo)
        if not slugs:
            slugs = [""]

        semaphore = asyncio.Semaphore(ZREAD_REMOTE_CONCURRENCY)

        async def fetch_page(slug: str) -> tuple[str, str | None]:
            async with semaphore:
                url = f"{base_url}/{slug}" if slug else base_url
                return slug, await _get(client, url)

        results = await asyncio.gather(*(fetch_page(slug) for slug in slugs))
        pages: list[dict[str, str]] = []
        total_bytes = 0
        for slug, html in results:
            if not html:
                continue
            markdown = _flight_markdown(html)
            if not markdown:
                continue
            remaining = ZREAD_REMOTE_MAX_BYTES - total_bytes
            if remaining <= 0:
                break
            encoded = markdown.encode("utf-8")
            if len(encoded) > remaining:
                markdown = encoded[:remaining].decode("utf-8", errors="ignore")
            pages.append({
                "path": f"zread/{slug or 'overview'}.md",
                "title": _page_title(markdown, slug or "overview"),
                "content": markdown,
                "sourceUrl": f"{base_url}/{slug}" if slug else base_url,
            })
            total_bytes += len(markdown.encode("utf-8"))

    if not pages:
        return None
    return {
        "provider": "zread-remote",
        "status": "complete" if len(pages) == len(slugs) else "partial",
        "repository": f"{owner}/{repo}",
        "commitSha": indexed_commit,
        "indexedCommitSha": indexed_commit,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pageCount": len(pages),
        "expectedPageCount": len(slugs),
        "truncated": total_bytes >= ZREAD_REMOTE_MAX_BYTES,
        "truncatedPages": [],
        "pages": pages,
    }


__all__ = ["fetch_zread_wiki"]
