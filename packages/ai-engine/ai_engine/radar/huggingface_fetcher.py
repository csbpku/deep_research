"""Hugging Face Hub models fetcher — trending models by weekly likes."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import datetime, timezone
import os
from typing import Any

import httpx

from ai_engine.radar.huggingface import huggingface_endpoint
from ai_engine.radar.models import RadarCandidate


def _timeout_seconds(config: Mapping[str, Any], default: float = 30.0) -> float:
    raw = config.get("timeoutSeconds", os.environ.get("HUGGINGFACE_TIMEOUT_SECONDS", default))
    try:
        return max(5.0, min(120.0, float(raw)))
    except (TypeError, ValueError):
        return default


def _retry_count(config: Mapping[str, Any]) -> int:
    raw = config.get("retries", os.environ.get("HUGGINGFACE_FETCH_RETRIES", "2"))
    try:
        return max(0, min(4, int(raw)))
    except (TypeError, ValueError):
        return 2


async def _get_models(
    http: httpx.AsyncClient,
    *,
    params: Mapping[str, Any],
    timeout: float,
    retries: int,
) -> Any:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = await http.get(
                huggingface_endpoint("/api/models"),
                params=dict(params),
                headers={"User-Agent": "deep-research-radar/0.1"},
                timeout=timeout,
            )
            if resp.status_code == 429 or resp.status_code >= 500:
                resp.raise_for_status()
            resp.raise_for_status()
            return resp.json()
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
            last_error = exc
        except httpx.HTTPStatusError as exc:
            if not (exc.response.status_code == 429 or exc.response.status_code >= 500):
                raise
            last_error = exc
        if attempt < retries:
            await asyncio.sleep(min(3.0, 0.5 * (attempt + 1)))
    if last_error is not None:
        raise last_error
    return []


async def fetch_huggingface_models(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = 15.0,
) -> list[RadarCandidate]:
    max_results = max(1, min(50, int(config.get("max_results", 30))))
    sort = str(config.get("sort", "likes7d"))
    request_timeout = _timeout_seconds(config, timeout)
    retries = _retry_count(config)

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=request_timeout)
    candidates: list[RadarCandidate] = []

    try:
        data = await _get_models(
            http,
            params={"sort": sort, "direction": "-1", "limit": max_results},
            timeout=request_timeout,
            retries=retries,
        )
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
