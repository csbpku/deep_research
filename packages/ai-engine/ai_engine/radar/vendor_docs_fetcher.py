"""Vendor documentation fetcher — turn vendor doc/guide changes into radar candidates.

Works with sitemap_watcher.py: when a sitemap detects a new or updated page,
this module fetches the page HTML, strips it to plain text, and packages it
as a RadarCandidate for the radar sync pipeline.

Supported vendors: Claude (platform.claude.com/docs), OpenAI (platform.openai.com/docs),
Hugging Face (huggingface.co/docs), LangChain (python.langchain.com/docs).
"""

from __future__ import annotations

import logging
import re as _re
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

logger = logging.getLogger("vendor_docs_fetcher")

_VENDOR_FETCH_CONFIGS: dict[str, dict[str, Any]] = {
    "claude": {
        "fetch_url_base": None,  # use the URL itself
        "title_selector": "title, h1",
        "content_selector": "article, main, .docs-content",
        "quality_hint": 0.9,
        "tags": ("vendor_docs", "claude", "anthropic"),
    },
    "openai": {
        "fetch_url_base": None,
        "quality_hint": 0.9,
        "tags": ("vendor_docs", "openai"),
    },
    "huggingface": {
        "quality_hint": 0.85,
        "tags": ("vendor_docs", "huggingface"),
    },
    "langchain": {
        "quality_hint": 0.85,
        "tags": ("vendor_docs", "langchain"),
    },
}

# Pages to watch beyond just sitemap: the Use Case Guides overview and individual guides
_STATIC_GUIDE_PAGES: dict[str, list[str]] = {
    "claude": [
        "https://platform.claude.com/docs/en/about-claude/use-case-guides/overview",
        "https://platform.claude.com/docs/en/about-claude/use-case-guides/ticket-routing",
        "https://platform.claude.com/docs/en/about-claude/use-case-guides/customer-support-agent",
        "https://platform.claude.com/docs/en/about-claude/use-case-guides/content-moderation",
        "https://platform.claude.com/docs/en/about-claude/use-case-guides/legal-summarization",
        "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview",
        "https://platform.claude.com/docs/en/agents-and-tools/tool-use/build-a-tool-using-agent",
        "https://platform.claude.com/docs/en/build-with-claude/overview",
        "https://platform.claude.com/docs/en/test-and-evaluate/overview",
        "https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/overview",
        "https://platform.claude.com/docs/en/test-and-evaluate/reduce-hallucinations",
        "https://platform.claude.com/docs/en/test-and-evaluate/increase-output-consistency",
    ],
    "openai": [
        "https://platform.openai.com/docs/guides/prompt-engineering",
        "https://platform.openai.com/docs/guides/function-calling",
        "https://platform.openai.com/docs/guides/structured-outputs",
        "https://platform.openai.com/docs/guides/vision",
        "https://platform.openai.com/docs/guides/text-generation",
        "https://platform.openai.com/docs/guides/chat-completions",
        "https://platform.openai.com/docs/guides/safety-best-practices",
        "https://platform.openai.com/docs/guides/latency-optimization",
    ],
}


def _strip_html_to_text(html: str) -> str:
    """Strip HTML tags to plain text."""
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
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    return "\n".join(lines)


def _infer_title(text: str, url: str) -> str:
    """Extract title from first meaningful line or URL path."""
    lines = text.strip().split("\n")
    for line in lines:
        line = line.strip()
        if line and len(line) > 5 and len(line) < 200:
            return line[:200]
    # Fallback: use last URL path segment
    path = url.rstrip("/").split("/")[-1]
    return path.replace("-", " ").replace("_", " ").title()[:200]


async def fetch_vendor_doc_page(
    url: str,
    *,
    vendor: str = "claude",
    client: httpx.AsyncClient | None = None,
) -> RadarCandidate | None:
    """Fetch a single vendor doc page and return a RadarCandidate.

    Args:
        url: Full URL of the doc page to fetch.
        vendor: Vendor identifier for config lookup.

    Returns:
        RadarCandidate if fetch succeeded, None otherwise.
    """
    config = _VENDOR_FETCH_CONFIGS.get(vendor, {})
    quality_hint = float(config.get("quality_hint", 0.8))
    tags = list(config.get("tags", ("vendor_docs", vendor)))

    owns_client = client is None
    http = client or httpx.AsyncClient(
        timeout=15.0,
        headers={"User-Agent": "deep-research-vendor-docs/0.1"},
        follow_redirects=True,
    )

    try:
        resp = await http.get(url)
        resp.raise_for_status()
        html = resp.text
    except Exception as exc:
        logger.warning("vendor_doc_fetch_failed", extra={"url": url, "error": str(exc)})
        return None
    finally:
        if owns_client:
            await http.aclose()

    text = _strip_html_to_text(html)

    # Skip if too short (likely error page or login wall)
    if len(text) < 100:
        logger.info("vendor_doc_too_short", extra={"url": url, "len": len(text)})
        return None

    title = _infer_title(text, url)
    snippet = text[:500].strip().replace("\n", " ")

    return RadarCandidate(
        title=title,
        url=url,
        snippet=snippet,
        published_at=datetime.now(timezone.utc),
        content_origin="web",
        tags=tuple(tags),
        source_quality_hint=quality_hint,
    )


async def fetch_vendor_docs_candidates(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    """Fetch vendor doc pages flagged by sitemap watcher.

    Config keys (all optional):
      - vendor (str, default "claude"): which vendor config to use.
      - urls (list[str], optional): specific URLs to fetch.
        If not provided, uses _STATIC_GUIDE_PAGES for the vendor.
      - include_sitemap_updates (bool, default True): also check sitemap
        for recently changed pages.
    """
    vendor = str(config.get("vendor", "claude")).lower()
    urls: list[str] = list(config.get("urls", _STATIC_GUIDE_PAGES.get(vendor, [])))
    include_sitemap = bool(config.get("include_sitemap_updates", True))

    # Sitemap check for updates
    if include_sitemap:
        try:
            from ai_engine.radar.sitemap_watcher import check_updates

            changes = await check_updates(vendor, client=client)
            for change in changes:
                url = change["url"]
                if url not in urls:
                    urls.append(url)
        except Exception as exc:
            logger.warning("sitemap_check_failed", extra={"vendor": vendor, "error": str(exc)})

    if not urls:
        return []

    candidates: list[RadarCandidate] = []
    for url in urls:
        candidate = await fetch_vendor_doc_page(
            url, vendor=vendor, client=client,
        )
        if candidate is not None:
            # Check for cache/state: if the URL hasn't changed since last
            # time we fetched it, skip (handled by sitemap check above,
            # but we also check content_sha256 at the sync_runner level).
            candidates.append(candidate)

    return candidates


__all__ = ["fetch_vendor_docs_candidates", "fetch_vendor_doc_page"]
