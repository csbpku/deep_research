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

_VENDOR_CONFIGS: dict[str, dict[str, Any]] = {
    "anthropic": {
        "sitemap_url": "https://www.anthropic.com/sitemap.xml",
        "url_pattern": r"/news/",
        "quality_hint": 0.9,
        "tags": ("vendor", "anthropic"),
    },
    "openai": {
        "sitemap_url": "https://openai.com/sitemap.xml",
        "url_pattern": r"/news/|/blog/",
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
    """Parse sitemap XML, return {url: lastmod} for matching urls."""
    results: dict[str, str] = {}
    pattern = _re.compile(url_pattern)
    # Handle both flat sitemap and sitemap index
    for match in _re.finditer(
        r"<url>\s*<loc>(.*?)</loc>(?:\s*<lastmod>(.*?)</lastmod>)?",
        xml, _re.DOTALL,
    ):
        url = match.group(1).strip()
        if not pattern.search(url):
            continue
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
        new_or_changed = []
        for url, lastmod in current_urls.items():
            prev = previous.get(url)
            if prev is None or (lastmod and prev != lastmod):
                new_or_changed.append(url)

        # 3. Persist state
        state[vendor] = current_urls
        _save_state(state)

        # 4. Fetch new/changed pages
        for url in new_or_changed:
            try:
                resp = await http.get(url)
                resp.raise_for_status()
                text = _extract_article_text(resp.text)
                if len(text) < 100:
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
