"""arXiv radar source fetcher with institution-based filtering."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from ai_engine.ingestion.sources import fetch_arxiv
from ai_engine.radar.arxiv_institution_filter import filter_papers_by_institution
from ai_engine.radar.models import RadarCandidate


async def fetch_arxiv_candidates(config: Mapping[str, Any]) -> list[RadarCandidate]:
    """Fetch recent arXiv papers, applying institution-based filtering.

    Config keys:
      - categories (list[str], optional): ArXiv categories to query.
        Default: ["cs.AI", "cs.CL"].
      - maxResults (int, optional, default 100): how many papers to fetch
        from API **before** filtering. Higher values give the institution
        filter more candidates to work with.
      - maxCandidates (int, optional, default 20): max papers to return
        **after** institution filtering.
      - keepTier (int, optional, default 3): institution tier threshold.
        1=top uni, 2=strong uni, 3=company, 4=all labs.
      - institutionFilter (bool, optional, default True): enable filtering.
    """

    raw_categories = config.get("categories", ["cs.AI", "cs.CL"])
    categories = [str(item).strip() for item in raw_categories if str(item).strip()]
    if not categories:
        raise ValueError("arXiv source requires at least one category")

    raw_max = config.get("maxResults", 100)
    if isinstance(raw_max, bool):
        raise ValueError("arXiv maxResults must be an integer")
    max_results = int(raw_max)
    if max_results < 1 or max_results > 200:
        raise ValueError("arXiv maxResults must be between 1 and 200")

    max_candidates = int(config.get("maxCandidates", 20))
    keep_tier = int(config.get("keepTier", 3))
    enable_filter = bool(config.get("institutionFilter", True))

    items = await fetch_arxiv(max_results=max_results, categories=categories)

    if enable_filter and categories:
        # Extend categories with cs.SE, cs.IR, cs.MA for broader coverage
        items = filter_papers_by_institution(items, keep_tier=keep_tier)

    candidates: list[RadarCandidate] = []
    for item in items[:max_candidates]:
        published_at = None
        raw_published = item.get("published_at") or item.get("published")
        if isinstance(raw_published, str) and raw_published:
            try:
                published_at = datetime.fromisoformat(raw_published.replace("Z", "+00:00"))
            except ValueError:
                pass

        tags_list: list[str] = ["arxiv"]
        matched = item.get("matched_institutions")
        if isinstance(matched, list) and matched:
            tags_list.append("institution_filtered")
            tags_list.extend(str(inst).lower().replace(" ", "_")[:30] for inst in matched)

        snippet = str(item.get("snippet") or item.get("summary") or "")[:2000]
        authors_data = item.get("authors", [])
        if isinstance(authors_data, list) and authors_data:
            author_names = [a.get("name", "") for a in authors_data if isinstance(a, dict)]
            if author_names:
                snippet = f"Authors: {', '.join(author_names[:5])}. {snippet}"

        candidates.append(
            RadarCandidate(
                title=str(item.get("title") or "Untitled")[:300],
                url=str(item.get("url") or ""),
                snippet=snippet,
                published_at=published_at,
                content_origin="api",
                tags=tuple(tags_list)[:20],
                source_quality_hint=0.9,
            )
        )
    return candidates


__all__ = ["fetch_arxiv_candidates"]
