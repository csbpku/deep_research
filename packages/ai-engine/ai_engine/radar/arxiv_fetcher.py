"""arXiv radar source fetcher."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ai_engine.ingestion.sources import fetch_arxiv
from ai_engine.radar.models import RadarCandidate


async def fetch_arxiv_candidates(config: Mapping[str, Any]) -> list[RadarCandidate]:
    """Fetch recent arXiv papers using the existing fixed-host API client."""

    raw_categories = config.get("categories", ["cs.AI", "cs.CL"])
    categories = [str(item).strip() for item in raw_categories if str(item).strip()]
    if not categories:
        raise ValueError("arXiv source requires at least one category")
    raw_max = config.get("maxResults", 50)
    if isinstance(raw_max, bool):
        raise ValueError("arXiv maxResults must be an integer")
    max_results = int(raw_max)
    if max_results < 1 or max_results > 100:
        raise ValueError("arXiv maxResults must be between 1 and 100")

    items = await fetch_arxiv(max_results=max_results, categories=categories)
    candidates: list[RadarCandidate] = []
    for item in items:
        published_at = None
        raw_published = item.get("published_at")
        if isinstance(raw_published, str) and raw_published:
            from datetime import datetime

            try:
                published_at = datetime.fromisoformat(raw_published.replace("Z", "+00:00"))
            except ValueError:
                pass
        candidates.append(
            RadarCandidate(
                title=str(item.get("title") or "Untitled")[:300],
                url=str(item.get("url") or ""),
                snippet=str(item.get("snippet") or "")[:2000],
                published_at=published_at,
                content_origin="api",
                tags=tuple(str(tag) for tag in item.get("tags", ["arxiv"]))[:20],
                source_quality_hint=0.9,
            )
        )
    return candidates


__all__ = ["fetch_arxiv_candidates"]
