"""Load and dispatch enabled radar source definitions."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, cast

from ai_engine.radar.arxiv_fetcher import fetch_arxiv_candidates
from ai_engine.radar.github import fetch_github
from ai_engine.radar.github_trending import fetch_github_trending
from ai_engine.radar.models import RadarCandidate, RadarSource, SourceType
from ai_engine.radar.rss_fetcher import fetch_rss_candidates
from ai_engine.radar.vendor_news_fetcher import check_and_fetch_vendor_news

# Optional fetchers — not all may be present in the deployed environment.
# Missing modules are caught at handler registration time so sources that
# depend on them fail fast instead of breaking the entire sync runner.
try:
    from ai_engine.radar.community_fetcher import (
        fetch_hackernews_candidates,
        fetch_reddit_candidates,
        fetch_lobsters_candidates,
        fetch_devto_candidates,
    )
    _HAVE_COMMUNITY = True
except ModuleNotFoundError:
    _HAVE_COMMUNITY = False
    fetch_hackernews_candidates = None  # type: ignore[assignment]
    fetch_reddit_candidates = None  # type: ignore[assignment]
    fetch_lobsters_candidates = None  # type: ignore[assignment]
    fetch_devto_candidates = None  # type: ignore[assignment]

try:
    from ai_engine.radar.producthunt_fetcher import fetch_producthunt_candidates
    _HAVE_PRODUCTHUNT = True
except ModuleNotFoundError:
    _HAVE_PRODUCTHUNT = False
    fetch_producthunt_candidates = None  # type: ignore[assignment]

try:
    from ai_engine.radar.github_topic_search import fetch_github_topic_search
    _HAVE_TOPIC_SEARCH = True
except ModuleNotFoundError:
    _HAVE_TOPIC_SEARCH = False
    fetch_github_topic_search = None  # type: ignore[assignment]

try:
    from ai_engine.radar.huggingface_fetcher import fetch_huggingface_models
    _HAVE_HF = True
except ModuleNotFoundError:
    _HAVE_HF = False
    fetch_huggingface_models = None  # type: ignore[assignment]

SourceFetcher = Callable[[dict[str, Any]], Awaitable[list[RadarCandidate]]]

_KNOWN_SOURCE_TYPES: set[str] = {
    "github", "github_trending", "arxiv", "rss",
    "hackernews", "reddit", "lobsters", "devto",
    "producthunt", "vendor_news", "sitemap_watch", "wechat",
    "github_topic_search", "huggingface_models",
}

_HANDLERS: dict[str, SourceFetcher] = {
    "github_trending": fetch_github_trending,
    "github": lambda cfg: fetch_github(cfg),
    "github_topic_search": fetch_github_topic_search,
    "arxiv": fetch_arxiv_candidates,
    "rss": fetch_rss_candidates,
    "hackernews": fetch_hackernews_candidates,
    "reddit": fetch_reddit_candidates,
    "lobsters": fetch_lobsters_candidates,
    "devto": fetch_devto_candidates,
    "producthunt": fetch_producthunt_candidates,
    "huggingface_models": fetch_huggingface_models,
    "vendor_news": lambda cfg: check_and_fetch_vendor_news(str(cfg.get("vendor", "anthropic"))),
}


async def load_enabled_sources(pool: Any) -> list[RadarSource]:
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id", "name", "sourceType", "config" '
                'FROM "radar_sources" WHERE "enabled" = true '
                'ORDER BY "createdAt" ASC'
            )
        ).fetchall()
    sources: list[RadarSource] = []
    for raw in rows:
        row = cast(dict[str, Any], raw)
        source_type = str(row["sourceType"])
        if source_type not in _KNOWN_SOURCE_TYPES:
            continue
        config = row.get("config")
        sources.append(
            RadarSource(
                id=str(row["id"]),
                name=str(row["name"]),
                source_type=cast(SourceType, source_type),
                config=dict(config) if isinstance(config, dict) else {},
            )
        )
    return sources


async def fetch_source(
    source: RadarSource,
    *,
    fetchers: dict[str, SourceFetcher] | None = None,
) -> list[RadarCandidate]:
    """Dispatch based on ``source_type``; honor ``mode`` for GitHub."""
    handlers = fetchers or _HANDLERS
    handler: SourceFetcher | None

    if fetchers is not None and source.source_type in handlers:
        handler = handlers[source.source_type]
    elif source.source_type == "github":
        mode = str(source.config.get("mode") or "trending").lower()
        handler_key = "github_trending" if mode == "trending" else "github"
        handler = handlers.get(handler_key)
    else:
        handler = handlers.get(source.source_type)

    if handler is None:
        raise ValueError(f"unsupported radar source type: {source.source_type}")
    return await handler(dict(source.config))


__all__ = ["SourceFetcher", "fetch_source", "load_enabled_sources"]
