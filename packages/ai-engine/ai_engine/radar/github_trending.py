"""GitHub Trending HTML scraper.

Adapted from kaiye/daily-report `github_trending.js`. Scrapes
``https://github.com/trending[/:lang]?since=:since`` HTML directly so it
avoids the 60 req/h REST API limit and gets richer trend signals
(stars_today, language, rank).

Returns ``RadarCandidate`` objects with tags ``('github', 'trending')`` and
source_quality_hint 0.85 (same as ``fetch_github``).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

_TRENDING_BASE = "https://github.com/trending"

# Patterns lifted from kaiye/daily-report.
_ARTICLE_RE = re.compile(r'<article class="Box-row">([\s\S]*?)</article>')
_README_ARTICLE_RE = re.compile(
    r'<article[^>]*class="[^"]*markdown-body[^"]*"[^>]*>([\s\S]*?)</article>'
)
_REPO_HREF_RE = re.compile(r'<h2[^>]*>\s*<a[^>]+href="/([^"]+)"')
_DESC_RE = re.compile(r'<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)</p>')
_LANG_RE = re.compile(
    r'itemprop="programmingLanguage"[^>]*>(.*?)</span>', re.DOTALL
)
_STARGAZERS_RE = re.compile(
    r'href="/[^/]+/[^/]+/stargazers"[^>]*>.*?</svg>\s*([\d,]+)',
    re.DOTALL,
)
_FORKS_RE = re.compile(
    r'href="/[^/]+/[^/]+/forks"[^>]*>.*?</svg>\s*([\d,]+)',
    re.DOTALL,
)
_STARS_TODAY_RE = re.compile(r'([\d,]+)\s*stars today')


def _strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


def _strip_html_entities(s: str) -> str:
    """Lightweight entity replacement matching kaiye's `utils/text.js`."""
    return (
        s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )


def _clean_readme_paragraphs(html: str, max_paragraphs: int = 2) -> str:
    article = _README_ARTICLE_RE.search(html)
    if not article:
        return ""
    body = article.group(1)
    paragraphs = re.findall(r"<p[^>]*>([\s\S]*?)</p>", body)
    cleaned = []
    for raw in paragraphs:
        text = _strip_html_entities(raw)
        text = re.sub(r"<br\s*/?>", " ", text)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"&#\d+;", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) >= 20:
            cleaned.append(text)
        if len(cleaned) >= max_paragraphs:
            break
    return "\n\n".join(cleaned).strip()


def _to_int(raw: str) -> int:
    digits = raw.replace(",", "").strip()
    try:
        return int(digits)
    except ValueError:
        return 0


def _parse_trending_block(block: str) -> dict[str, Any] | None:
    repo_match = _REPO_HREF_RE.search(block)
    if not repo_match:
        return None
    name = repo_match.group(1).strip()
    if not name:
        return None

    desc_raw = _DESC_RE.search(block)
    desc = _strip_html(desc_raw.group(1)) if desc_raw else ""

    lang_match = _LANG_RE.search(block)
    language = lang_match.group(1).strip() if lang_match else ""

    stars_match = _STARGAZERS_RE.search(block)
    stars_total = _to_int(stars_match.group(1)) if stars_match else 0

    forks_match = _FORKS_RE.search(block)
    forks = _to_int(forks_match.group(1)) if forks_match else 0

    today_match = _STARS_TODAY_RE.search(block)
    stars_today = _to_int(today_match.group(1)) if today_match else 0

    return {
        "repo": name,
        "url": f"https://github.com/{name}",
        "description": desc,
        "language": language,
        "stars_total": stars_total,
        "forks": forks,
        "stars_today": stars_today,
    }


async def fetch_github_trending(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = 15.0,
) -> list[RadarCandidate]:
    """Scrape ``github.com/trending`` HTML.

    Config keys:
      - ``language`` (str, optional): empty / python / typescript / …
      - ``since`` (str, optional): ``daily`` / ``weekly`` / ``monthly``
        (default ``daily``).
      - ``max_results`` (int, optional, default 25): cap on returned items.
    """

    language = str(config.get("language") or "").strip()
    since = str(config.get("since") or "daily").lower()
    if since not in {"daily", "weekly", "monthly"}:
        raise ValueError("GitHub trending since must be daily, weekly, or monthly")
    raw_max = config.get("max_results", 25)
    if isinstance(raw_max, bool) or not isinstance(raw_max, int):
        raise ValueError("GitHub trending max_results must be an integer")
    max_results = raw_max
    if max_results < 1 or max_results > 100:
        raise ValueError("GitHub trending max_results must be between 1 and 100")

    url = _TRENDING_BASE + (f"/{language}" if language else "") + f"?since={since}"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 "
            "Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    }

    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=timeout, headers=headers)
    parsed_items: list[dict[str, Any]] = []
    try:
        resp = await http_client.get(url)
        resp.raise_for_status()
        html = resp.text
    finally:
        if owns_client:
            await http_client.aclose()

    for block_match in _ARTICLE_RE.finditer(html):
        if len(parsed_items) >= max_results:
            break
        parsed = _parse_trending_block(block_match.group(1))
        if parsed:
            parsed_items.append(parsed)

    # README fallback — when description is empty, fetch the repo page and
    # pull the first paragraphs of the README article. Mirrors kaiye's
    # `enrichMissingDescriptions()`.
    needs_readme = [item for item in parsed_items if not item["description"]]
    if needs_readme:
        owns_client = client is None
        readme_client = client or httpx.AsyncClient(timeout=timeout, headers=headers)
        try:
            for item in needs_readme:
                try:
                    resp = await readme_client.get(item["url"])
                    resp.raise_for_status()
                    excerpt = _clean_readme_paragraphs(resp.text)
                    if excerpt:
                        item["description"] = excerpt
                except Exception:
                    # README enrichment is best-effort; fall through with
                    # whatever description we already have.
                    pass
        finally:
            if owns_client and client is None:
                await readme_client.aclose()

    candidates: list[RadarCandidate] = []
    for parsed in parsed_items:
        snippet_parts = [parsed["description"]]
        if parsed["language"]:
            snippet_parts.append(f"Language: {parsed['language']}")
        snippet_parts.append(f"Stars: {parsed['stars_total']:,}")
        if parsed["stars_today"]:
            snippet_parts.append(f"+{parsed['stars_today']} stars {since}")
        snippet = " · ".join(p for p in snippet_parts if p).strip()

        # rank + stars_today -> timeliness hint
        timeliness_hint = min(0.95, 0.5 + (parsed["stars_today"] / 1000.0))
        candidates.append(
            RadarCandidate(
                title=parsed["repo"][:300],
                url=parsed["url"],
                snippet=snippet[:2000],
                published_at=datetime.now(timezone.utc),
                content_origin="web",
                tags=("github", "trending", parsed["language"].lower() or "unknown"),
                source_quality_hint=0.85,
                timeliness_hint=timeliness_hint,
            )
        )

    return candidates


__all__ = ["fetch_github_trending"]