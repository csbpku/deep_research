"""Load and dispatch enabled radar source definitions."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, cast

from ai_engine.radar.arxiv_fetcher import fetch_arxiv_candidates
from ai_engine.radar.github import fetch_github
from ai_engine.radar.models import RadarCandidate, RadarSource, SourceType
from ai_engine.radar.rss_fetcher import fetch_rss_candidates

SourceFetcher = Callable[[dict[str, Any]], Awaitable[list[RadarCandidate]]]


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
        if source_type not in {"github", "arxiv", "rss"}:
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
    handlers: dict[str, SourceFetcher] = fetchers or {
        "github": fetch_github,
        "arxiv": fetch_arxiv_candidates,
        "rss": fetch_rss_candidates,
    }
    fetcher = handlers.get(source.source_type)
    if fetcher is None:
        raise ValueError(f"unsupported radar source type: {source.source_type}")
    return await fetcher(source.config)


__all__ = ["SourceFetcher", "fetch_source", "load_enabled_sources"]
