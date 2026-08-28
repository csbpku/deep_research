"""Read already-generated public Zread pages before invoking the local CLI.

Zread currently server-renders the page as Next.js flight data. The response
contains the generated Markdown, page catalog, and indexed Git commit, so we
can reuse public documentation without cloning the repository or spending
another LLM generation budget. This adapter is intentionally best-effort;
callers still fall back to the local CLI and then GitHub README.
"""

from __future__ import annotations

import asyncio
import html as html_lib
import json
import os
import re
import time
from typing import Any

import httpx

ZREAD_REMOTE_MAX_BYTES = 2_000_000
# Zread is behind a rate-limited edge; a small bounded fan-out is more
# reliable than the previous four-request burst during backfills.
ZREAD_REMOTE_CONCURRENCY = 2
ZREAD_REMOTE_PARSER_VERSION = 4
ZREAD_REMOTE_MAX_RESPONSE_BYTES = 2_000_000
ZREAD_REMOTE_REQUEST_TIMEOUT_SECONDS = 30.0
ZREAD_REMOTE_TOTAL_TIMEOUT_SECONDS = 180.0
_FLIGHT_STRING = re.compile(
    r'self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)'
)
_PAGE_LINK = re.compile(
    r'href=["\']/((?P<owner>[A-Za-z0-9_.-]+)/(?P<repo>[A-Za-z0-9_.-]+)/(?P<slug>[A-Za-z0-9][A-Za-z0-9_-]*))["\']'
)
_CATALOG_PAGE = re.compile(
    r'"page_id"\s*:\s*"[^"]+"\s*,\s*"topic"\s*:\s*"([^"]*)"\s*,\s*'
    r'"group"\s*:\s*"([^"]*)"\s*,\s*"section"\s*:\s*"([^"]*)"\s*,\s*'
    r'"slug"\s*:\s*"([A-Za-z0-9][A-Za-z0-9_-]*)"'
)
_COMMIT = re.compile(r'"commit"\s*:\s*\{"hash"\s*:\s*"([0-9a-f]{7,64})"')


def _decode_json_string(value: str) -> str:
    """Decode one or more JSON-escape layers in a flight/catalog string.

    The catalog is embedded in a Next.js flight string, so a value such as
    ``&`` can arrive as either ``\\u0026`` or ``\\\\u0026`` after the outer
    JavaScript string is unescaped.  Decode the bounded number of layers
    instead of persisting the remaining escape sequence as user-visible text.
    """
    decoded = value
    for _ in range(3):
        try:
            candidate = json.loads(f'"{decoded}"')
        except (json.JSONDecodeError, TypeError):
            break
        if not isinstance(candidate, str) or candidate == decoded:
            break
        decoded = candidate
    return decoded


def _enabled() -> bool:
    return os.environ.get("ZREAD_REMOTE_ENABLED", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }


def _page_title(markdown: str, slug: str) -> str:
    match = re.search(r'^#\s+(.+?)\s*$', markdown, re.MULTILINE)
    if match:
        return match.group(1).strip()[:200]
    return slug.replace("-", " ").replace("_", " ").title()[:200]


def _html_page_title(page_html: str, slug: str) -> str | None:
    match = re.search(r"<h1[^>]*>(.*?)</h1>", page_html, re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    text = re.sub(r"<[^>]+>", "", match.group(1))
    text = html_lib.unescape(re.sub(r"\s+", " ", text)).strip()
    return text[:200] or None


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
    # The page catalog is also embedded as JSON in the Next.js flight stream;
    # it may not be rendered as hrefs in the raw response. Restrict this
    # fallback to the catalog object shape so slugs inside article prose or
    # code examples are not mistaken for documentation pages.
    catalog_slugs = [entry["slug"] for entry in _page_catalog(normalized)]
    for slug in catalog_slugs:
        if slug not in seen:
            seen.add(slug)
            slugs.append(slug)
    return slugs


def _page_catalog(html: str) -> list[dict[str, str]]:
    normalized = html.replace('\\"', '"')
    catalog: list[dict[str, str]] = []
    for topic, group, section, slug in _CATALOG_PAGE.findall(normalized):
        decoded_slug = _decode_json_string(slug).strip()
        if not decoded_slug:
            continue
        catalog.append({
            "topic": _decode_json_string(topic).strip(),
            "group": _decode_json_string(group).strip(),
            "section": _decode_json_string(section).strip(),
            "slug": decoded_slug,
        })
    return catalog


async def _get(client: httpx.AsyncClient, url: str) -> str | None:
    async def _read_response() -> str | None:
        async with client.stream("GET", url) as response:
            if response.status_code == 429 or response.status_code >= 500:
                return None
            response.raise_for_status()
            content_length = response.headers.get("content-length")
            if content_length:
                try:
                    if int(content_length) > ZREAD_REMOTE_MAX_RESPONSE_BYTES:
                        return None
                except ValueError:
                    pass
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > ZREAD_REMOTE_MAX_RESPONSE_BYTES:
                    return None
                chunks.append(chunk)
            if not chunks:
                return None
            return b"".join(chunks).decode("utf-8", errors="replace")

    for attempt in range(3):
        try:
            result = await asyncio.wait_for(
                _read_response(),
                timeout=ZREAD_REMOTE_REQUEST_TIMEOUT_SECONDS,
            )
            if result:
                return result
            if attempt == 2:
                return None
        except (httpx.HTTPError, OSError):
            if attempt == 2:
                return None
        except asyncio.TimeoutError:
            if attempt == 2:
                return None
        await asyncio.sleep(1.0 + attempt)
    return None


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
    async def _fetch() -> dict[str, Any] | None:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(
                ZREAD_REMOTE_REQUEST_TIMEOUT_SECONDS,
                connect=15.0,
            ),
            headers=headers,
        ) as client:
            root_html = await _get(client, base_url)
            if not root_html:
                return None
            commit_match = _COMMIT.search(root_html.replace('\\"', '"'))
            indexed_commit = commit_match.group(1) if commit_match else None
            catalog = _page_catalog(root_html.replace('\\"', '"'))
            catalog_by_slug = {entry["slug"]: entry for entry in catalog}
            catalog_page_count = len(catalog)
            slugs = [entry["slug"] for entry in catalog] or _page_refs(root_html, owner, repo)
            catalog_page_count = max(catalog_page_count, len(slugs))
            if not slugs:
                slugs = [""]

            semaphore = asyncio.Semaphore(ZREAD_REMOTE_CONCURRENCY)

            async def fetch_page(slug: str) -> tuple[str, str | None]:
                async with semaphore:
                    url = f"{base_url}/{slug}" if slug else base_url
                    return slug, await _get(client, url)

            results: list[tuple[str, str | None]] = []
            # Fetch in bounded pages rather than firing an unbounded request
            # fan-out.  There is deliberately no page-count cap: the catalog
            # is the source of truth, and every page is fetched in order.
            for start in range(0, len(slugs), ZREAD_REMOTE_CONCURRENCY):
                batch = slugs[start : start + ZREAD_REMOTE_CONCURRENCY]
                results.extend(await asyncio.gather(*(fetch_page(slug) for slug in batch)))
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
                catalog_entry = catalog_by_slug.get(slug, {})
                page_payload: dict[str, str] = {
                    "path": f"zread/{slug or 'overview'}.md",
                    "title": catalog_entry.get("topic") or _html_page_title(html, slug or "overview") or _page_title(markdown, slug or "overview"),
                    "content": markdown,
                    "sourceUrl": f"{base_url}/{slug}" if slug else base_url,
                }
                if catalog_entry.get("group"):
                    page_payload["group"] = catalog_entry["group"]
                if catalog_entry.get("section"):
                    page_payload["section"] = catalog_entry["section"]
                pages.append(page_payload)
                total_bytes += len(markdown.encode("utf-8"))

        if not pages:
            return None
        return {
            "provider": "zread-remote",
            "parserVersion": ZREAD_REMOTE_PARSER_VERSION,
            "status": "complete" if len(pages) == catalog_page_count else "partial",
            "repository": f"{owner}/{repo}",
            "commitSha": indexed_commit,
            "indexedCommitSha": indexed_commit,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "pageCount": len(pages),
            "expectedPageCount": catalog_page_count,
            "truncated": total_bytes >= ZREAD_REMOTE_MAX_BYTES,
            "truncatedPages": [],
            "pages": pages,
        }

    try:
        return await asyncio.wait_for(
            _fetch(),
            timeout=ZREAD_REMOTE_TOTAL_TIMEOUT_SECONDS,
        )
    except (asyncio.TimeoutError, httpx.HTTPError, OSError):
        return None


__all__ = ["fetch_zread_wiki"]
