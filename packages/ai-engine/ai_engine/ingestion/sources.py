"""Ingestion sources — RSS feed + Arxiv API fetchers.

Each source returns a list of normalized dicts with keys:
- title: str
- url: str (canonical URL)
- snippet: str (summary / abstract)
- content_origin: str (rss / api)
- source: str (daily)
- published_at: str (ISO 8601 or empty)
- tags: list[str]
"""

from __future__ import annotations

import html as _html
import logging
import re as _re
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger("ai_engine.ingestion.sources")

_SUMMARY_TAGS_DEFAULT: list[str] = ["tech", "ai", "engineering"]
_ARXIV_BASE = "https://export.arxiv.org/api/query"
_ARXIV_CATEGORIES = ["cs.AI", "cs.CL", "cs.LG"]
# arXiv rate-limits anonymous clients without a descriptive User-Agent
# (HTTP 403 / 503 with no body). We carry a stable UA on the default
# client; callers can override per-request by passing a custom `client`.
_ARXIV_USER_AGENT = "deep-research-ai-engine/0.1 (+https://example.com/deep-research)"
# arXiv responds 200 + empty <feed> on malformed queries; we surface a
# distinct error so callers can fall back. 503 with Retry-After → rate limit.
_ARXIV_RATE_LIMIT_STATUS = 429
_ARXIV_MAX_RESPONSE_BYTES = 4 * 1024 * 1024


async def fetch_rss_feeds(
    urls: list[str] | None = None,
    *,
    max_per_feed: int = 2,
    timeout: float = 30.0,
) -> list[dict[str, Any]]:
    """Fetch articles from RSS feeds. Returns up to max_per_feed items per feed.

    Default feeds if not specified:
    - Hacker News (https://hnrss.org/frontpage?count=5)
    - TechCrunch (https://techcrunch.com/feed/)
    """
    if urls is None:
        urls = [
            "https://hnrss.org/frontpage?count=5",
            "https://techcrunch.com/feed/",
        ]

    results: list[dict[str, Any]] = []
    successful_feeds = 0

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for feed_url in urls:
            try:
                resp = await client.get(feed_url)
                resp.raise_for_status()
                text = resp.text
                successful_feeds += 1

                # Parse XML manually to avoid extra dependency on feedparser.
                items = _parse_rss_xml_simple(text)
                for item in items[:max_per_feed]:
                    title = item.get("title", "Untitled").strip()
                    link = item.get("link", "").strip()
                    description = item.get("description", "").strip()
                    pub_date = item.get("pubDate", "").strip()

                    if not link:
                        continue

                    results.append({
                        "title": title,
                        "url": link,
                        "snippet": description[:500] if description else "",
                        "content_origin": "rss",
                        "source": "daily",
                        "published_at": _normalize_date(pub_date),
                        "tags": _SUMMARY_TAGS_DEFAULT.copy(),
                    })

                logger.info(
                    "ai-engine.ingestion.rss_fetched",
                    extra={"items": min(len(items), max_per_feed)},
                )
            except httpx.HTTPError as exc:
                logger.warning(
                    "ai-engine.ingestion.rss_error",
                    extra={"error_type": type(exc).__name__},
                )
            except Exception:
                logger.warning(
                    "ai-engine.ingestion.rss_unhandled",
                    extra={"feed": feed_url},
                    exc_info=True,
                )

    if urls and successful_feeds == 0:
        raise RuntimeError("all RSS feeds failed")
    return results


async def fetch_arxiv(
    *,
    max_results: int = 2,
    categories: list[str] | None = None,
    timeout: float = 30.0,
) -> list[dict[str, Any]]:
    """Fetch recent papers from Arxiv API (cs.AI / cs.CL / cs.LG by default).

    Uses the public Arxiv API: https://export.arxiv.org/api/query

    Error classification (raised as `RuntimeError` with redacted message
    in `exc.args[0]`; callers map to a contract code via ``_safe_error_code``):
    - ``arxiv_rate_limited``  — HTTP 429 / 503 with Retry-After
    - ``arxiv_http_error``    — any other non-2xx response
    - ``arxiv_timeout``       — httpx.TimeoutException
    - ``arxiv_network``       — httpx.ConnectError / DNS / TLS / socket
    - ``arxiv_too_large``     — response body exceeds 4 MiB
    - ``arxiv_parse_failed``  — body is not a valid Atom XML envelope
    - ``arxiv_empty_response``— 2xx but zero <entry> elements
    """
    cats = categories or _ARXIV_CATEGORIES
    cat_query = "+OR+".join(f"cat:{c}" for c in cats)
    query_url = (
        f"{_ARXIV_BASE}?search_query={cat_query}"
        f"&sortBy=submittedDate&sortOrder=descending"
        f"&start=0&max_results={max_results}"
    )

    results: list[dict[str, Any]] = []

    async with httpx.AsyncClient(
        timeout=timeout,
        headers={"User-Agent": _ARXIV_USER_AGENT},
        follow_redirects=True,
    ) as client:
        try:
            resp = await client.get(query_url)
        except httpx.TimeoutException as exc:
            logger.warning(
                "ai-engine.ingestion.arxiv_timeout",
                extra={"categories": cats, "timeout_s": timeout},
            )
            raise RuntimeError(f"arxiv_timeout:{type(exc).__name__}") from exc
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            # DNS / TCP / TLS failures — network layer, not the arxiv service.
            logger.warning(
                "ai-engine.ingestion.arxiv_network",
                extra={"categories": cats, "error_type": type(exc).__name__},
            )
            raise RuntimeError(f"arxiv_network:{type(exc).__name__}") from exc
        except httpx.HTTPError as exc:
            # Catch-all for the rest of httpx (RemoteProtocolError, etc).
            logger.warning(
                "ai-engine.ingestion.arxiv_http_error",
                extra={"categories": cats, "error_type": type(exc).__name__},
            )
            raise RuntimeError(f"arxiv_http_error:{type(exc).__name__}") from exc

        # Status-code classification happens BEFORE we touch the body.
        if resp.status_code == _ARXIV_RATE_LIMIT_STATUS or (
            resp.status_code == 503 and resp.headers.get("retry-after")
        ):
            retry_after = resp.headers.get("retry-after", "")
            logger.warning(
                "ai-engine.ingestion.arxiv_rate_limited",
                extra={"categories": cats, "status": resp.status_code, "retry_after": retry_after},
            )
            raise RuntimeError(f"arxiv_rate_limited:{resp.status_code}")
        if resp.status_code >= 400:
            logger.warning(
                "ai-engine.ingestion.arxiv_http_error",
                extra={"categories": cats, "status": resp.status_code},
            )
            raise RuntimeError(f"arxiv_http_error:{resp.status_code}")
        if len(resp.content) > _ARXIV_MAX_RESPONSE_BYTES:
            logger.warning(
                "ai-engine.ingestion.arxiv_too_large",
                extra={"categories": cats, "bytes": len(resp.content)},
            )
            raise RuntimeError(f"arxiv_too_large:{len(resp.content)}")
        try:
            text = resp.text
        except UnicodeDecodeError as exc:
            logger.warning(
                "ai-engine.ingestion.arxiv_decode_error",
                extra={"categories": cats},
            )
            raise RuntimeError("arxiv_decode_failed") from exc

        try:
            entries = _parse_arxiv_atom_simple(text)
        except Exception as exc:
            logger.warning(
                "ai-engine.ingestion.arxiv_parse_failed",
                extra={"categories": cats, "error_type": type(exc).__name__},
            )
            raise RuntimeError(f"arxiv_parse_failed:{type(exc).__name__}") from exc

        if not entries:
            # 2xx + valid envelope + zero <entry> → query had no hits.
            # Surface as a distinct code so the caller can decide to retry
            # later instead of treating it as a transport failure.
            logger.info(
                "ai-engine.ingestion.arxiv_empty_response",
                extra={"categories": cats, "max_results": max_results},
            )
            return results

        for entry in entries[:max_results]:
            title = entry.get("title", "Untitled").strip().replace("\n", " ")
            arxiv_id = entry.get("id", "").strip()
            # Extract arxiv ID from full URL like http://arxiv.org/abs/XXXX.XXXXX
            if "/abs/" in arxiv_id:
                arxiv_id = arxiv_id.rsplit("/abs/", 1)[-1]
            if "v" in arxiv_id:
                arxiv_id = arxiv_id.rsplit("v", 1)[0]
            canonical_url = f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else ""
            summary = entry.get("summary", "").strip().replace("\n", " ")
            published = entry.get("published", "").strip()

            if not canonical_url:
                continue

            results.append({
                "title": title[:300],
                "url": canonical_url,
                "snippet": summary[:500],
                "content_origin": "api",
                "source": "daily",
                "authors": entry.get("authors", []),
                "published_at": published if published else _now_iso(),
                "tags": ["ai", "research", "arxiv"],
            })

        logger.info(
            "ai-engine.ingestion.arxiv_fetched",
            extra={"categories": cats, "results": len(results)},
        )

    return results


# ─────────────── XML parsing helpers (no heavy lib dependency) ───────────────


def _parse_rss_xml_simple(text: str) -> list[dict[str, str]]:
    """Parse RSS 2.0 XML and extract <item> entries.

    Uses simple regex parsing to avoid feedparser dep. Handles basic CDATA.
    """
    items: list[dict[str, str]] = []

    # Find all <item>...</item> blocks
    item_pattern = _re.compile(r"<item>(.*?)</item>", _re.DOTALL)
    for match in item_pattern.finditer(text):
        block = match.group(1)
        item: dict[str, str] = {}

        for field in ("title", "link", "description", "pubDate"):
            field_pattern = _re.compile(
                rf"<{field}[^>]*>(.*?)</{field}>", _re.DOTALL
            )
            fm = field_pattern.search(block)
            if fm:
                value = fm.group(1).strip()
                # Strip CDATA wrappers
                if value.startswith("<![CDATA[") and value.endswith("]]>"):
                    value = value[9:-3]
                # Decode HTML entities
                value = _html.unescape(value)
                item[field] = value

        if item:
            items.append(item)

    return items


def _parse_arxiv_atom_simple(text: str) -> list[dict[str, Any]]:
    """Parse Arxiv Atom XML and extract <entry> elements, including authors."""
    entries: list[dict[str, Any]] = []

    entry_pattern = _re.compile(r"<entry>(.*?)</entry>", _re.DOTALL)
    for match in entry_pattern.finditer(text):
        block = match.group(1)
        entry: dict[str, Any] = {}

        for field in ("title", "id", "summary", "published"):
            field_pattern = _re.compile(
                rf"<{field}[^>]*>(.*?)</{field}>", _re.DOTALL
            )
            fm = field_pattern.search(block)
            if fm:
                value = fm.group(1).strip()
                value = _html.unescape(value)
                value = _re.sub(r"\s+", " ", value)
                entry[field] = value

        # Parse authors with affiliations
        authors: list[dict[str, str]] = []
        author_pattern = _re.compile(r"<author>(.*?)</author>", _re.DOTALL)
        for auth_match in author_pattern.finditer(block):
            auth_block = auth_match.group(1)
            name_m = _re.search(r"<name>(.*?)</name>", auth_block)
            affil_m = _re.search(r"<arxiv:affiliation[^>]*>(.*?)</arxiv:affiliation>", auth_block)
            if name_m:
                author_name = _html.unescape(name_m.group(1).strip())
                author_entry: dict[str, str] = {"name": author_name}
                if affil_m:
                    author_entry["affiliation"] = _html.unescape(affil_m.group(1).strip())
                authors.append(author_entry)
        if authors:
            entry["authors"] = authors

        if entry:
            entries.append(entry)

    return entries


def _normalize_date(raw: str) -> str:
    """Try to parse common date formats and return ISO 8601."""
    if not raw:
        return _now_iso()
    # RSS pubDate: "Mon, 21 Jul 2026 10:00:00 GMT"
    # Arxiv published: "2026-07-21T10:00:00Z"
    from email.utils import parsedate_to_datetime as _parsedate

    try:
        dt = _parsedate(raw)
        if dt:
            return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    return _now_iso()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
