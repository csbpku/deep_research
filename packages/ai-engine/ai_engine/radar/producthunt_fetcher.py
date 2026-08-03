"""Product Hunt radar source fetcher — GraphQL API."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
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

_AI_TOPICS = {
    "artificial-intelligence",
    "machine-learning",
    "ai",
    "chatgpt",
    "llm",
    "developer-tools",
    "open-source",
    "natural-language-processing",
    "chatbots",
    "generative-ai",
}

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
    max_results = max(1, min(30, int(config.get("max_results", 30))))
    fetch_count = 20  # PH API complexity limit caps this at ~20

    query = """
    query($first: Int!, $postedAfter: DateTime, $postedBefore: DateTime) {
      posts(first: $first, postedAfter: $postedAfter, postedBefore: $postedBefore, order: VOTES) {
        edges {
          node {
            id
            name
            tagline
            url
            website
            votesCount
            commentsCount
            createdAt
            topics { edges { node { slug name } } }
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
    candidates: list[tuple[RadarCandidate, int]] = []
    now = datetime.now(timezone.utc)

    try:
        posted_after = now - timedelta(hours=48)
        posted_before = now - timedelta(hours=24)
        resp = await http.post(
            _PH_API,
            json={
                "query": query,
                "variables": {
                    "first": fetch_count,
                    "postedAfter": posted_after.isoformat(),
                    "postedBefore": posted_before.isoformat(),
                },
            },
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
    for edge in edges[:fetch_count]:
        node = edge.get("node", {})
        if not isinstance(node, dict):
            continue
        name = node.get("name", "").strip()
        tagline = node.get("tagline", "").strip()
        url = node.get("url", "").strip()
        votes = int(node.get("votesCount") or 0)
        comments = int(node.get("commentsCount") or 0)
        created_str = node.get("createdAt", "")
        topics_raw = node.get("topics", {}).get("edges", [])
        topic_names: list[str] = []
        topic_slugs: list[str] = []
        for t in topics_raw:
            if not isinstance(t, dict):
                continue
            topic_node = t.get("node", {})
            if isinstance(topic_node, dict):
                if topic_node.get("name"):
                    topic_names.append(str(topic_node["name"]))
                if topic_node.get("slug"):
                    topic_slugs.append(str(topic_node["slug"]))

        if not name or not url:
            continue
        if not _is_ai_related(name, tagline, topic_slugs + topic_names):
            continue

        published = None
        if isinstance(created_str, str):
            try:
                published = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
            except ValueError:
                published = datetime.now(timezone.utc)

        snippet = f"{tagline} | votes: {votes} | comments: {comments} | topics: {', '.join(topic_names[:4])}"
        candidates.append((RadarCandidate(
            title=name,
            url=url,
            snippet=snippet[:500],
            published_at=published,
            content_origin="api",
            tags=("producthunt", "ai_tool") + tuple(t.lower().replace(" ", "-") for t in topic_names[:4]),
            source_quality_hint=0.75,
        ), votes))

    ranked = sorted(candidates, key=lambda pair: pair[1], reverse=True)
    return [candidate for candidate, _ in ranked[:max_results]]
