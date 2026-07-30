"""GitHub topic search fetcher — search AI-related repos updated in last 7 days."""

from __future__ import annotations

import os
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

_GITHUB_API = "https://api.github.com/search/repositories"
_AI_TOPICS = ("llm", "ai-agent", "rag", "vector-database", "large-language-model", "machine-learning")


def _headers(token: str | None) -> dict[str, str]:
    result = {"Accept": "application/vnd.github+json", "User-Agent": "deep-research-radar/0.1", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        result["Authorization"] = f"Bearer {token}"
    return result


def _parse_ts(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


async def fetch_github_topic_search(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = 15.0,
) -> list[RadarCandidate]:
    topics = list(config.get("topics", _AI_TOPICS))
    max_per_topic = max(1, min(15, int(config.get("max_per_topic", 15))))
    max_results = max(1, min(50, int(config.get("max_results", 20))))

    owns_client = client is None
    token = os.getenv("GH_TOKEN")
    http = client or httpx.AsyncClient(timeout=timeout, headers=_headers(token))
    candidates: list[RadarCandidate] = []
    seen_urls: set[str] = set()

    try:
        for topic in topics:
            try:
                resp = await http.get(_GITHUB_API, params={
                    "q": f"topic:{topic} pushed:>={(datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d')}",
                    "sort": "stars", "order": "desc", "per_page": max_per_topic,
                })
                resp.raise_for_status()
                data = resp.json()
            except Exception:
                continue
            items = data.get("items", []) if isinstance(data, dict) else []
            for item in items[:max_per_topic]:
                if not isinstance(item, dict):
                    continue
                url = item.get("html_url", "")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                name = item.get("full_name", "")
                desc = item.get("description", "") or ""
                stars = item.get("stargazers_count", 0)
                lang = item.get("language", "") or ""
                snippet_parts = [desc[:300]]
                if lang:
                    snippet_parts.append(f"Language: {lang}")
                snippet_parts.append(f"Stars: {stars}")
                snippet = " · ".join(p for p in snippet_parts if p)
                candidates.append(RadarCandidate(
                    title=name[:300], url=url, snippet=snippet[:2000],
                    published_at=_parse_ts(item.get("pushed_at")),
                    content_origin="api",
                    tags=("github", "topic_search", topic),
                    source_quality_hint=0.85,
                ))
                if len(candidates) >= max_results:
                    break
            if len(candidates) >= max_results:
                break
    finally:
        if owns_client:
            await http.aclose()
    return candidates
