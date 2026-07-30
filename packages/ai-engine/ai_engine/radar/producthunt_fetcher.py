"""Product Hunt radar source fetcher — GraphQL API."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

_PH_API = "https://api.producthunt.com/v2/api/graphql"

_AI_KEYWORDS = [
    "ai", "人工智能", "llm", "gpt", "agent", "chatbot", "copilot",
    "machine learning", "deep learning", "neural", "nlp", "rag",
    "embedding", "vector", "langchain", "autogen", "crewai",
    "mcp", "model context protocol", "fine-tune", "fine tune",
    "inference", "prompt", "workflow automation",
]

_AI_TOPICS = {"ai", "artificial-intelligence", "machine-learning", "developer-tools", "productivity", "open-source", "data-analytics"}

_SHORT_KW_RE_PH: dict[str, re.Pattern[str]] = {}
for _kw in _AI_KEYWORDS:
    _stripped = _kw.strip()
    if len(_stripped) <= 4 and not re.search(r"[^\x00-\x7f]", _stripped):
        _SHORT_KW_RE_PH[_kw] = re.compile(
            r"(?<![a-z0-9])" + re.escape(_stripped) + r"(?![a-z0-9])",
            re.IGNORECASE,
        )


def _is_ai_related(name: str, tagline: str, topics: list[str]) -> bool:
    corpus = f"{name} {tagline}".lower()
    for kw in _AI_KEYWORDS:
        pattern = _SHORT_KW_RE_PH.get(kw)
        if pattern is not None:
            if pattern.search(corpus):
                return True
        elif kw in corpus:
            return True
    for t in topics:
        if t.lower() in _AI_TOPICS:
            return True
    return False


async def fetch_producthunt_candidates(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    max_results = max(1, min(25, int(config.get("max_results", 10))))

    query = """
    query($first: Int!) {
      posts(first: $first, order: VOTES) {
        edges {
          node {
            id
            name
            tagline
            url
            votesCount
            createdAt
            topics { edges { node { name } } }
          }
        }
      }
    }
    """

    token = (config.get("api_token") or os.getenv("PRODUCTHUNT_API_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("producthunt_fetch_failed: PRODUCTHUNT_API_TOKEN 未配置")

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=15.0)
    candidates: list[RadarCandidate] = []

    try:
        resp = await http.post(
            _PH_API,
            json={"query": query, "variables": {"first": max_results * 2}},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "deep-research-radar/0.1",
            },
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        raise RuntimeError(f"producthunt_fetch_failed: {exc}") from exc
    finally:
        if owns_client:
            await http.aclose()

    edges = data.get("data", {}).get("posts", {}).get("edges", [])
    for edge in edges[:max_results * 2]:
        node = edge.get("node", {})
        if not isinstance(node, dict):
            continue
        name = node.get("name", "").strip()
        tagline = node.get("tagline", "").strip()
        url = node.get("url", "").strip()
        votes = int(node.get("votesCount") or 0)
        created_str = node.get("createdAt", "")
        topics_raw = node.get("topics", {}).get("edges", [])
        topic_names = [t.get("node", {}).get("name", "") for t in topics_raw if isinstance(t, dict)]

        if not name or not url:
            continue
        if not _is_ai_related(name, tagline, topic_names):
            continue

        published = None
        if isinstance(created_str, str):
            try:
                published = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
            except ValueError:
                published = datetime.now(timezone.utc)

        snippet = f"{tagline} | votes: {votes} | topics: {', '.join(topic_names[:4])}"
        candidates.append(RadarCandidate(
            title=name,
            url=url,
            snippet=snippet[:500],
            published_at=published,
            content_origin="api",
            tags=("producthunt", "ai_tool") + tuple(t.lower().replace(" ", "-") for t in topic_names[:4]),
            source_quality_hint=0.75,
        ))
        if len(candidates) >= max_results:
            break

    return candidates
