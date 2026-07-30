"""Vendor news fetcher — crawl vendor sites without RSS via sitemap + HTML.

For vendors that don't offer RSS (Anthropic, OpenAI, etc.), we detect new
pages via sitemap lastmod changes and extract article content from HTML.

Supported vendors:
  - anthropic (www.anthropic.com/news/*)
  - openai (openai.com/news/* or openai.com/blog/*)
"""

from __future__ import annotations

import logging
import os
import re as _re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

logger = logging.getLogger("vendor_news_fetcher")

# Cap on first-run fetch: when no previous state exists, all sitemap URLs
# are "new". This limit prevents fetching hundreds of pages on first run.
_FIRST_RUN_MAX_FETCH = 10

_VENDOR_CONFIGS: dict[str, dict[str, Any]] = {
    "anthropic": {
        "sitemap_url": "https://www.anthropic.com/sitemap.xml",
        "url_pattern": r"/news/",
        "quality_hint": 0.9,
        "tags": ("vendor", "anthropic"),
    },
    "openai": {
        "sitemap_url": "https://openai.com/news/rss.xml",
        "url_pattern": r"/index/|/news/|/blog/",
        "quality_hint": 0.9,
        "tags": ("vendor", "openai"),
    },
}


def _state_path() -> Path:
    default = Path(__file__).parent.parent / "static_docs" / ".vendor_news_state.json"
    return Path(os.environ.get("VENDOR_NEWS_STATE_PATH", str(default)))


def _load_state() -> dict[str, dict[str, str]]:
    path = _state_path()
    if path.exists():
        try:
            import json
            with open(path) as f:
                return dict(json.load(f))
        except Exception:
            return {}
    return {}


def _save_state(state: dict[str, dict[str, str]]) -> None:
    import json
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    tmp.replace(path)


async def _fetch_sitemap(url: str, *, client: httpx.AsyncClient) -> str:
    resp = await client.get(url, timeout=15.0)
    resp.raise_for_status()
    return resp.text


def _parse_sitemap(xml: str, url_pattern: str) -> dict[str, str]:
    """Parse sitemap XML or RSS feed, return {url: lastmod} for matching urls.

    Handles three formats:
    - Sitemap index: <sitemap><loc>...</loc></sitemap> → returns empty
      (caller should follow sub-sitemaps; not implemented here)
    - URL sitemap: <url><loc>...</loc><lastmod>...</lastmod></url>
    - RSS feed: <item><link>...</link><pubDate>...</pubDate></item>
    """
    results: dict[str, str] = {}
    pattern = _re.compile(url_pattern)

    # URL sitemap entries
    for match in _re.finditer(
        r"<url>\s*<loc>(.*?)</loc>(?:\s*<lastmod>(.*?)</lastmod>)?",
        xml, _re.DOTALL,
    ):
        url = match.group(1).strip()
        if not pattern.search(url):
            continue
        results[url] = (match.group(2) or "").strip()

    # RSS feed entries (for vendors that offer RSS instead of sitemap)
    for match in _re.finditer(
        r"<item>.*?<link>(.*?)</link>.*?(?:<pubDate>(.*?)</pubDate>)?",
        xml, _re.DOTALL,
    ):
        url = match.group(1).strip()
        if not pattern.search(url):
            continue
        if url not in results:
            results[url] = (match.group(2) or "").strip()

    # Atom feed entries
    for match in _re.finditer(
        r"<entry>.*?<link[^>]*href=\"([^\"]+)\".*?(?:<published>(.*?)</published>)?",
        xml, _re.DOTALL,
    ):
        url = match.group(1).strip()
        if not pattern.search(url):
            continue
        if url not in results:
            results[url] = (match.group(2) or "").strip()

    return results


def _extract_article_text(html: str) -> str:
    """Strip HTML to article text."""
    text = _re.sub(r"<script[^>]*>.*?</script>", "", html, flags=_re.DOTALL)
    text = _re.sub(r"<style[^>]*>.*?</style>", "", text, flags=_re.DOTALL)
    text = _re.sub(r"<nav[^>]*>.*?</nav>", "", text, flags=_re.DOTALL)
    text = _re.sub(r"<footer[^>]*>.*?</footer>", "", text, flags=_re.DOTALL)
    text = _re.sub(r"<[^>]+>", "\n", text)
    text = _re.sub(r"&nbsp;", " ", text)
    text = _re.sub(r"&amp;", "&", text)
    text = _re.sub(r"&lt;", "<", text)
    text = _re.sub(r"&gt;", ">", text)
    text = _re.sub(r"&quot;", '"', text)
    text = _re.sub(r"\n\s*\n", "\n\n", text)
    lines = [line.strip() for line in text.split("\n") if line.strip() and len(line.strip()) > 5]
    return "\n".join(lines)


def _parse_rss_items(xml: str) -> dict[str, dict[str, str]]:
    """Parse RSS <item> elements, return {url: {title, description, pubDate}}."""
    results: dict[str, dict[str, str]] = {}
    for match in _re.finditer(r"<item>(.*?)</item>", xml, _re.DOTALL):
        block = match.group(1)
        item: dict[str, str] = {}
        for field in ("title", "link", "description", "pubDate"):
            fm = _re.search(rf"<{field}[^>]*>(.*?)</{field}>", block, _re.DOTALL)
            if fm:
                value = fm.group(1).strip()
                if value.startswith("<![CDATA[") and value.endswith("]]>"):
                    value = value[9:-3]
                item[field] = value
        link = item.get("link", "").strip()
        if link:
            results[link] = item
    return results


def _infer_title(text: str, url: str) -> str:
    lines = text.strip().split("\n")
    for line in lines:
        line = line.strip()
        if line and 5 < len(line) < 200:
            return line[:200]
    path = url.rstrip("/").split("/")[-1]
    return path.replace("-", " ").replace("_", " ").title()[:200]


async def check_and_fetch_vendor_news(
    vendor: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    """Check vendor sitemap for new/updated news pages and fetch them.

    Returns RadarCandidate list for newly detected articles.
    """
    cfg = _VENDOR_CONFIGS.get(vendor)
    if not cfg:
        raise ValueError(f"unknown vendor: {vendor}")

    owns_client = client is None
    http = client or httpx.AsyncClient(
        timeout=15.0,
        headers={"User-Agent": "deep-research-vendor-news/0.1"},
        follow_redirects=True,
    )
    candidates: list[RadarCandidate] = []

    try:
        # 1. Fetch sitemap
        xml = await _fetch_sitemap(cfg["sitemap_url"], client=http)
        current_urls = _parse_sitemap(xml, cfg["url_pattern"])

        # 2. Diff with previous state
        state = _load_state()
        previous = state.get(vendor, {})
        is_first_run = len(previous) == 0
        new_or_changed = []
        for url, lastmod in current_urls.items():
            prev = previous.get(url)
            if prev is None or (lastmod and prev != lastmod):
                new_or_changed.append(url)

        # First-run cap: only fetch the N most recent URLs to avoid
        # overwhelming the vendor site and our pipeline on initial setup.
        if is_first_run and len(new_or_changed) > _FIRST_RUN_MAX_FETCH:
            logger.info(
                "vendor_news_first_run_cap",
                extra={
                    "vendor": vendor,
                    "total_new": len(new_or_changed),
                    "capped_to": _FIRST_RUN_MAX_FETCH,
                },
            )
            new_or_changed = new_or_changed[:_FIRST_RUN_MAX_FETCH]

        # 3. Persist state
        state[vendor] = current_urls
        _save_state(state)

        # 4. Parse RSS metadata for fallback (when HTML pages require JS)
        rss_metadata = _parse_rss_items(xml) if "<item>" in xml else {}

        # 5. Fetch new/changed pages
        for url in new_or_changed:
            try:
                resp = await http.get(url)
                resp.raise_for_status()
                text = _extract_article_text(resp.text)
                if len(text) < 100:
                    # HTML extraction failed (JS-required pages like OpenAI).
                    # Fall back to RSS <description> if available.
                    meta = rss_metadata.get(url, {})
                    desc = meta.get("description", "").strip()
                    rss_title = meta.get("title", "").strip()
                    if rss_title or desc:
                        title = rss_title or _infer_title(desc, url)
                        snippet = desc[:500] if desc else title
                        candidates.append(RadarCandidate(
                            title=title[:300],
                            url=url,
                            snippet=snippet,
                            published_at=datetime.now(timezone.utc),
                            content_origin="web",
                            tags=cfg["tags"],
                            source_quality_hint=cfg["quality_hint"],
                        ))
                    continue
                title = _infer_title(text, url)
                snippet = text[:500].replace("\n", " ")
                candidates.append(RadarCandidate(
                    title=title,
                    url=url,
                    snippet=snippet,
                    published_at=datetime.now(timezone.utc),
                    content_origin="web",
                    tags=cfg["tags"],
                    source_quality_hint=cfg["quality_hint"],
                ))
            except Exception as exc:
                # Last resort: use RSS metadata if HTML fetch failed entirely
                meta = rss_metadata.get(url, {})
                rss_title = meta.get("title", "").strip()
                desc = meta.get("description", "").strip()
                if rss_title or desc:
                    title = rss_title or _infer_title(desc, url)
                    snippet = desc[:500] if desc else title
                    candidates.append(RadarCandidate(
                        title=title[:300],
                        url=url,
                        snippet=snippet,
                        published_at=datetime.now(timezone.utc),
                        content_origin="web",
                        tags=cfg["tags"],
                        source_quality_hint=cfg["quality_hint"],
                    ))
                else:
                    logger.warning("vendor_news_fetch_failed", extra={"url": url, "error": str(exc)})

        logger.info(
            "vendor_news_checked",
            extra={
                "vendor": vendor,
                "total_in_sitemap": len(current_urls),
                "new_or_changed": len(new_or_changed),
                "fetched": len(candidates),
            },
        )
    finally:
        if owns_client:
            await http.aclose()

    return candidates
