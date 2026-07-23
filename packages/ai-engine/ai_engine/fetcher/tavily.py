"""Tavily Search API fetcher — W3 真实现。

ClaudeAdapter._execute_step(SEARCH) 调用 `search(topic, max_results=5)`
获取真实搜索结果。不再使用 example.test 占位 URL。

API: POST https://api.tavily.com/search
Doc: https://docs.tavily.com/docs/rest-api/search
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger("ai_engine.fetcher.tavily")

_TAVILY_BASE = "https://api.tavily.com"


def _api_key() -> str:
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "TAVILY_API_KEY is not set; Tavily search is disabled. "
            "Set it in packages/ai-engine/.env (Week 1 key is available)."
        )
    return key


async def search(
    query: str,
    *,
    max_results: int = 5,
    search_depth: str = "basic",
    include_domains: list[str] | None = None,
    exclude_domains: list[str] | None = None,
    timeout: float = 30.0,
) -> list[dict[str, Any]]:
    """Execute a Tavily search and return a list of result dicts.

    Each result dict has keys:
      - url: str
      - title: str
      - content: str (snippet)
      - score: float (relevance score)
      - raw_content: str | None (full page text, only when search_depth='advanced')

    Raises RuntimeError on API/network errors (caller catches and logs).
    """
    key = _api_key()
    payload: dict[str, Any] = {
        "api_key": key,
        "query": query,
        "max_results": max_results,
        "search_depth": search_depth,
    }
    if include_domains:
        payload["include_domains"] = include_domains
    if exclude_domains:
        payload["exclude_domains"] = exclude_domains

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(
                f"{_TAVILY_BASE}/search",
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "ai-engine.tavily.http_error",
                extra={"status": exc.response.status_code},
            )
            raise RuntimeError(
                f"Tavily API returned {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            logger.error(
                "ai-engine.tavily.network_error",
                extra={"error_type": type(exc).__name__},
            )
            raise RuntimeError(f"Tavily API unreachable: {exc}") from exc

    data = resp.json()
    results: list[dict[str, Any]] = data.get("results", [])
    logger.info(
        "ai-engine.tavily.search",
        extra={
            "results_count": len(results),
            "response_time": data.get("response_time", "?"),
        },
    )
    return results
