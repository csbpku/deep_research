"""HN Algolia fetcher — keyword- and time-filtered Hacker News stories.

The existing ``fetch_hackernews_candidates`` reads the unscoped front-page and
relies on a coarse regex to filter AI stories out of whatever floats to the
top. That approach fails for time-bounded searches ("what AI stories made
front-page in the last 6h?") and is dominated by whatever crypto/personal-blog
post happens to be trending in the snapshot we grabbed.

The Algolia search API solves both problems: it indexes every HN story with
``created_at_i`` (UTC unix epoch seconds) and lets us run a full-text query
plus a numeric filter for the lookback window. This fetcher coexists with
the existing one — admin can enable either or both — and emits canonical
``https://news.ycombinator.com/item?id=<id>`` URLs when the external link is
missing.

Reference: https://hn.algolia.com/api
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

_HN_ALGOLIA_SEARCH = "https://hn.algolia.com/api/v1/search_by_date"

_DEFAULT_QUERY = "AI OR LLM OR agent OR chatgpt OR claude OR gemini"


def _is_story_hit(hit: Mapping[str, Any]) -> bool:
    """Algolia returns stories, comments, polls, ask_hn, show_hn. Keep only stories."""
    tags = hit.get("_tags") or []
    return isinstance(tags, list) and "story" in tags


def _author_or_none(value: Any) -> str:
    return value if isinstance(value, str) and value else ""


async def fetch_hn_algolia(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = 15.0,
) -> list[RadarCandidate]:
    max_results = max(1, min(100, int(config.get("maxResults", 30))))
    max_age_hours = max(1, int(config.get("maxAgeHours", 24)))
    min_points = max(0, int(config.get("minPoints", 0)))
    min_comments = max(0, int(config.get("minComments", 0)))
    query = str(config.get("query", _DEFAULT_QUERY)).strip() or _DEFAULT_QUERY
    tags_filter_raw = config.get("tags", "story")
    tags_filter = tags_filter_raw if isinstance(tags_filter_raw, str) else "story"

    since_ts = int(
        (datetime.now(timezone.utc).timestamp() - max_age_hours * 3600)
    )

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout)
    candidates: list[RadarCandidate] = []

    try:
        params: dict[str, Any] = {
            "query": query,
            "tags": tags_filter,
            "numericFilters": f"created_at_i>{since_ts}",
            "hitsPerPage": min(max_results * 2, 100),  # fetch extra so we have headroom for filters
        }
        resp = await http.get(
            _HN_ALGOLIA_SEARCH,
            params=params,
            headers={"User-Agent": "deep-research-radar/0.1"},
        )
        resp.raise_for_status()
        try:
            payload = resp.json()
        except ValueError:
            return candidates
        hits = payload.get("hits") if isinstance(payload, dict) else None
        if not isinstance(hits, list):
            return candidates

        for hit in hits:
            if len(candidates) >= max_results:
                break
            if not isinstance(hit, dict) or not _is_story_hit(hit):
                continue
            title_raw = hit.get("title")
            if not isinstance(title_raw, str) or not title_raw.strip():
                continue
            title = title_raw.strip()[:300]

            points_raw = hit.get("points")
            comments_raw = hit.get("num_comments")
            points = int(points_raw) if isinstance(points_raw, (int, float)) else 0
            comments = int(comments_raw) if isinstance(comments_raw, (int, float)) else 0
            if points < min_points or comments < min_comments:
                continue

            created_at = hit.get("created_at")
            published: datetime | None = None
            if isinstance(created_at, str):
                normalized = created_at.replace("Z", "+00:00") if created_at.endswith("Z") else created_at
                try:
                    published = datetime.fromisoformat(normalized)
                except ValueError:
                    published = None
            created_at_i = hit.get("created_at_i")
            if published is None and isinstance(created_at_i, (int, float)):
                try:
                    published = datetime.fromtimestamp(int(created_at_i), tz=timezone.utc)
                except (OverflowError, OSError, ValueError):
                    published = None

            object_id = hit.get("objectID")
            if not isinstance(object_id, str) and not isinstance(object_id, int):
                continue
            external_url_raw = hit.get("url")
            external_url = external_url_raw.strip() if isinstance(external_url_raw, str) and external_url_raw.strip() else ""
            hn_url = f"https://news.ycombinator.com/item?id={object_id}"
            url = external_url or hn_url

            author = _author_or_none(hit.get("author"))
            story_id = hit.get("story_id") or object_id

            snippet_parts: list[str] = [
                f"HN points: {points} | comments: {comments} | id {story_id}",
            ]
            if author:
                snippet_parts.append(f"by {author}")
            story_text = hit.get("story_text")
            if isinstance(story_text, str) and story_text.strip():
                # Strip basic HTML — Algolia returns <p> wrappers on story_text.
                snippet_parts.append(_strip_html(story_text)[:600])
            snippet = "\n".join(snippet_parts)[:2000]

            tags = ("hackernews", "hn_algolia")

            candidates.append(RadarCandidate(
                title=title,
                url=url,
                snippet=snippet,
                published_at=published,
                content_origin="api",
                tags=tags,
                source_quality_hint=0.80,
            ))
    finally:
        if owns_client:
            await http.aclose()

    return candidates[:max_results]


def _strip_html(text: str) -> str:
    """Tiny HTML stripper — keep it lightweight since HN's story_text is only ~600 chars."""
    import re

    cleaned = re.sub(r"<[^>]+>", " ", text)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()
