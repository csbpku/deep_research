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

try:  # pragma: no cover - exercised only when curl_cffi is missing
    from curl_cffi.requests import AsyncSession as _CurlAsyncSession
    from curl_cffi.requests import exceptions as _curl_exceptions
    _HAS_CURL_CFFI = True
except ImportError:  # pragma: no cover - exercised only when curl_cffi is missing
    _HAS_CURL_CFFI = False
    _CurlAsyncSession = None  # type: ignore[assignment, misc]
    _curl_exceptions = None  # type: ignore[assignment]

import httpx
from httpx import HTTPError as _HttpxHTTPError

# Curl-cffi's libcurl backend is the only path that survives Cloudflare.
# ``chrome136`` matches the most recent fingerprint we observed successfully
# traversing the zread.ai edge in September 2026; older impersonates (notably
# chrome124) started hitting per-IP token-bucket rate limits after a long
# burst of fetches. The env override remains so operators can pin a different
# fingerprint if Cloudflare rolls it onto the blacklist.
ZREAD_REMOTE_IMPERSONATE = os.environ.get(
    "ZREAD_REMOTE_IMPERSONATE", "chrome136"
).strip() or "chrome136"

ZREAD_REMOTE_MAX_BYTES = 2_000_000
# Keep one in-flight request at a time, but do not impose a stale fixed
# one-minute delay between pages. A current direct probe can fetch a 25-page
# wiki in single-digit seconds; the old default made ordinary wikis exceed
# the enrichment worker's 900s item timeout before all pages were requested.
# Operators can still set a positive interval when an upstream edge starts
# throttling again.
ZREAD_REMOTE_CONCURRENCY = max(
    1, int(os.environ.get("ZREAD_REMOTE_CONCURRENCY", "1"))
)
ZREAD_REMOTE_PARSER_VERSION = 4
ZREAD_REMOTE_MAX_RESPONSE_BYTES = 2_000_000
# 30s used to be enough for a ~250kB body; on the throttled edge a single
# page can trickle for 60s+ before the bucket drops the connection, and
# we killed responses right as the content arrived. 120s gives the slow
# path room to complete while still failing fast on true hangs.
ZREAD_REMOTE_REQUEST_TIMEOUT_SECONDS = float(
    os.environ.get("ZREAD_REMOTE_REQUEST_TIMEOUT_SECONDS", "120")
)
# One repo = 1 catalog + N page fetches. With N=22 and a 60s pacing, an
# honest run needs ~22+ minutes per repo; the previous 180s budget cut
# off mid-catalog and forced every repo into ``partial``. 1800s matches
# the long CLI item-timeout budget and still aborts runaway hangs.
ZREAD_REMOTE_TOTAL_TIMEOUT_SECONDS = float(
    os.environ.get("ZREAD_REMOTE_TOTAL_TIMEOUT_SECONDS", "1800")
)
# The root page is only a discovery request. If it cannot answer promptly,
# spending the full per-page retry budget here prevents the local CLI from
# taking over. Once a catalog is found, page requests use the longer timeout
# above because the remote wiki may legitimately be slow.
ZREAD_REMOTE_ROOT_TIMEOUT_SECONDS = float(
    os.environ.get("ZREAD_REMOTE_ROOT_TIMEOUT_SECONDS", "45")
)
# Module-level min interval between ANY zread-remote HTTP request, sharing
# across concurrent fetch_zread_wiki calls. Set to 0 to use the upstream's
# natural response pacing; a positive value remains an operational override.
ZREAD_REMOTE_MIN_INTERVAL_SECONDS = float(
    os.environ.get("ZREAD_REMOTE_MIN_INTERVAL_SECONDS", "0")
)
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


# --- Cross-call rate limiter -------------------------------------------------
# Cloudflare's token-bucket treats our IP/UA combination to roughly one
# successful request per minute. Without pacing, repeated back-to-back
# fetches mostly time out and burn the per-request budget. The limiter
# below is global so two fetch_zread_wiki calls running in parallel cannot
# each fire into the same window.
_zread_remote_lock = asyncio.Lock()
_zread_remote_last_request_ts: float = 0.0


async def _zread_remote_rate_limit() -> None:
    """Block until at least ZREAD_REMOTE_MIN_INTERVAL_SECONDS elapsed."""
    if ZREAD_REMOTE_MIN_INTERVAL_SECONDS <= 0:
        return
    async with _zread_remote_lock:
        global _zread_remote_last_request_ts
        now = time.monotonic()
        gap = now - _zread_remote_last_request_ts
        wait = ZREAD_REMOTE_MIN_INTERVAL_SECONDS - gap
        if wait > 0:
            await asyncio.sleep(wait)
        _zread_remote_last_request_ts = time.monotonic()


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


async def _get(client: Any, url: str) -> str | None:
    """Read a single URL with bounded body size and three retries.

    ``client`` is either a ``curl_cffi`` ``AsyncSession`` (preferred, survives
    Cloudflare) or a legacy ``httpx.AsyncClient`` (CI / dep-missing path).
    Streaming is used to enforce ``ZREAD_REMOTE_MAX_RESPONSE_BYTES`` before
    the whole body is buffered.
    """
    await _zread_remote_rate_limit()

    async def _read_response() -> str | None:
        if _HAS_CURL_CFFI and _CurlAsyncSession is not None and isinstance(
            client, _CurlAsyncSession
        ):
            # curl_cffi streams as an async generator rather than a context
            # manager. ``aiter_content`` yields decoded ``str`` chunks when
            # ``decode_unicode=True``; we want raw bytes for size accounting.
            chunks: list[bytes] = []
            size = 0
            # curl_cffi's ``stream()`` is an ``@asynccontextmanager`` that
            # yields a single ``Response`` (matches the httpx semantics).
            # The context manager's ``__aexit__`` calls ``response.aclose()``
            # for us, so we do not need to close manually on early returns.
            async with client.stream(
                "GET", url, timeout=ZREAD_REMOTE_REQUEST_TIMEOUT_SECONDS
            ) as response:
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
                async for chunk in response.aiter_content(chunk_size=16_384):
                    if isinstance(chunk, str):
                        chunk = chunk.encode("utf-8", errors="replace")
                    size += len(chunk)
                    if size > ZREAD_REMOTE_MAX_RESPONSE_BYTES:
                        return None
                    chunks.append(chunk)
                if not chunks:
                    return None
                return b"".join(chunks).decode("utf-8", errors="replace")

        # Legacy httpx path (used only when curl_cffi is unavailable).
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
            chunks_legacy: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > ZREAD_REMOTE_MAX_RESPONSE_BYTES:
                    return None
                chunks_legacy.append(chunk)
            if not chunks_legacy:
                return None
            return b"".join(chunks_legacy).decode("utf-8", errors="replace")

    retryable: tuple[type[BaseException], ...]
    if _HAS_CURL_CFFI and _curl_exceptions is not None:
        retryable = (
            _curl_exceptions.RequestException,
            _curl_exceptions.Timeout,
            _curl_exceptions.ConnectionError,
            _curl_exceptions.DNSError,
            OSError,
        )
    else:
        retryable = (_HttpxHTTPError, OSError)

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
        except retryable:
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
    print(f"[zread-debug] enter owner={owner} repo={repo} impersonate={ZREAD_REMOTE_IMPERSONATE}", flush=True)
    if not _enabled():
        print("[zread-debug] _enabled() returned False", flush=True)
        return None
    base_url = f"https://zread.ai/{owner}/{repo}"
    # zread.ai sits behind Cloudflare and throttles unrecognized UAs down to
    # a partial, time-out-prone response. With curl_cffi we present a real
    # Chrome 124 fingerprint (TLS + HTTP/2 + headers) so the edge serves the
    # full HTML. When curl_cffi is unavailable we fall back to plain httpx
    # with the same Accept headers but a weaker TLS fingerprint; that path is
    # kept only so dep-constrained deployments (CI, minimal images) still
    # work — it is expected to be flaky.
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    async def _fetch() -> dict[str, Any] | None:
        if _HAS_CURL_CFFI and _CurlAsyncSession is not None:
            client_cm: Any = _CurlAsyncSession(
                impersonate=ZREAD_REMOTE_IMPERSONATE,
                headers=headers,
                timeout=ZREAD_REMOTE_REQUEST_TIMEOUT_SECONDS,
                max_clients=ZREAD_REMOTE_CONCURRENCY + 4,
            )
        else:
            client_cm = httpx.AsyncClient(
                follow_redirects=True,
                timeout=httpx.Timeout(
                    ZREAD_REMOTE_REQUEST_TIMEOUT_SECONDS,
                    connect=15.0,
                ),
                headers=headers,
            )
        async with client_cm as client:
            print("[zread-debug] client opened", flush=True)
            root_html = await asyncio.wait_for(
                _get(client, base_url),
                timeout=min(
                    max(1.0, ZREAD_REMOTE_ROOT_TIMEOUT_SECONDS),
                    max(1.0, ZREAD_REMOTE_TOTAL_TIMEOUT_SECONDS),
                ),
            )
            if not root_html:
                print("[zread-debug] root_html empty len=0, exiting", flush=True)
                return None
            print(f"[zread-debug] root_html received bytes={len(root_html)}", flush=True)
            commit_match = _COMMIT.search(root_html.replace('\\"', '"'))
            indexed_commit = commit_match.group(1) if commit_match else None
            catalog = _page_catalog(root_html.replace('\\"', '"'))
            catalog_by_slug = {entry["slug"]: entry for entry in catalog}
            catalog_page_count = len(catalog)
            slugs = [entry["slug"] for entry in catalog] or _page_refs(root_html, owner, repo)
            catalog_page_count = max(catalog_page_count, len(slugs))
            if not slugs:
                # A Cloudflare/app shell can be a large successful response
                # without containing either the Zread catalog or page links.
                # Fetching the root URL a second time cannot discover pages
                # and needlessly holds the enrichment lease until the remote
                # total timeout. Treat this as an unavailable remote snapshot.
                root_markdown = _flight_markdown(root_html)
                if not root_markdown:
                    print("[zread-debug] no catalog or root markdown, exiting", flush=True)
                    return None
                print("[zread-debug] root-only markdown snapshot", flush=True)
                return {
                    "provider": "zread-remote",
                    "parserVersion": ZREAD_REMOTE_PARSER_VERSION,
                    "status": "complete",
                    "repository": f"{owner}/{repo}",
                    "commitSha": indexed_commit,
                    "indexedCommitSha": indexed_commit,
                    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "pageCount": 1,
                    "expectedPageCount": 1,
                    "truncated": False,
                    "truncatedPages": [],
                    "pages": [{
                        "path": "zread/overview.md",
                        "title": _html_page_title(root_html, "overview") or _page_title(root_markdown, "overview"),
                        "content": root_markdown,
                        "sourceUrl": base_url,
                    }],
                }
            print(f"[zread-debug] catalog parsed slugs={len(slugs)} catalog_pages={catalog_page_count}", flush=True)

            semaphore = asyncio.Semaphore(ZREAD_REMOTE_CONCURRENCY)

            async def fetch_page(slug: str) -> tuple[str, str | None]:
                async with semaphore:
                    url = f"{base_url}/{slug}" if slug else base_url
                    print(f"[zread-debug] page start slug={slug!r}", flush=True)
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
            print("[zread-debug] no pages collected, returning None", flush=True)
            return None
        print(f"[zread-debug] all pages done count={len(pages)} expected={catalog_page_count}", flush=True)
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
    except (
        asyncio.TimeoutError,
        _HttpxHTTPError,
        *(
            (_curl_exceptions.RequestException,)
            if _curl_exceptions is not None
            else ()
        ),
        OSError,
    ):
        return None


__all__ = ["fetch_zread_wiki"]
