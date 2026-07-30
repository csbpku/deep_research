"""Hugging Face Hub models fetcher — trending models by weekly likes."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

_HF_API = "https://huggingface.co/api/models"


async def fetch_huggingface_models(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = 15.0,
) -> list[RadarCandidate]:
    max_results = max(1, min(50, int(config.get("max_results", 30))))
    sort = str(config.get("sort", "likes7d"))

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout)
    candidates: list[RadarCandidate] = []

    try:
        resp = await http.get(_HF_API, params={"sort": sort, "direction": "-1", "limit": max_results}, headers={"User-Agent": "deep-research-radar/0.1"})
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list):
            return candidates

        for item in data[:max_results]:
            if not isinstance(item, dict):
                continue
            model_id = item.get("id", "") or item.get("modelId", "")
            if not model_id:
                continue
            url = f"https://huggingface.co/{model_id}"
            downloads = item.get("downloads", 0)
            likes = item.get("likes", 0)
            tags = item.get("tags", [])
            pipeline_tag = item.get("pipeline_tag", "") or ""
            snippet_parts = []
            if pipeline_tag:
                snippet_parts.append(f"Task: {pipeline_tag}")
            if downloads:
                snippet_parts.append(f"Downloads: {downloads}")
            if likes:
                snippet_parts.append(f"Likes: {likes}")
            if isinstance(tags, list):
                relevant_tags = [t for t in tags if isinstance(t, str) and not t.startswith("license:")][:5]
                if relevant_tags:
                    snippet_parts.append(f"Tags: {', '.join(relevant_tags)}")
            snippet = " · ".join(snippet_parts) if snippet_parts else model_id
            candidates.append(RadarCandidate(
                title=model_id[:300], url=url, snippet=snippet[:2000],
                published_at=datetime.now(timezone.utc), content_origin="api",
                tags=("huggingface", "model", pipeline_tag) if pipeline_tag else ("huggingface", "model"),
                source_quality_hint=0.80,
            ))
    finally:
        if owns_client:
            await http.aclose()
    return candidates
