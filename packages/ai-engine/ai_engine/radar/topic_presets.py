"""Preset topic configuration for deterministic radar aggregation."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TopicPreset:
    name: str
    slug: str
    description: str
    keywords: tuple[str, ...]
    refresh_cron: str
    enabled: bool = True


DEFAULT_TOPIC_PRESETS: tuple[TopicPreset, ...] = (
    TopicPreset("AI Agents", "ai-agents", "Agent frameworks, runtimes and production patterns.", ("agent", "agents", "agentic"), "06:00"),
    TopicPreset("RAG 与检索", "rag-retrieval", "Retrieval, reranking, vector databases and knowledge systems.", ("rag", "retrieval", "rerank", "vector database"), "06:00"),
    TopicPreset("MCP 与 Agent 协议", "mcp-protocols", "Model Context Protocol and interoperable agent tools.", ("mcp", "model context protocol"), "06:00"),
)


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9一-鿿]+", "-", value.casefold()).strip("-")[:120]


def load_topic_presets() -> tuple[TopicPreset, ...]:
    raw = os.environ.get("TOPIC_PRESETS_JSON", "").strip()
    if not raw:
        return DEFAULT_TOPIC_PRESETS
    try:
        values = json.loads(raw)
    except json.JSONDecodeError:
        return DEFAULT_TOPIC_PRESETS
    if not isinstance(values, list):
        return DEFAULT_TOPIC_PRESETS

    presets: list[TopicPreset] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        name = str(value.get("name", "")).strip()[:200]
        if not name:
            continue
        keywords = tuple(
            str(item).strip().casefold()
            for item in value.get("keywords", [])
            if isinstance(item, str) and item.strip()
        )
        presets.append(TopicPreset(
            name=name,
            slug=str(value.get("slug") or _slug(name))[:120],
            description=str(value.get("description", "")).strip()[:2000],
            keywords=keywords,
            refresh_cron=str(value.get("refreshCron") or value.get("refresh_cron") or "06:00"),
            enabled=value.get("enabled", True) is not False,
        ))
    return tuple(presets) or DEFAULT_TOPIC_PRESETS


__all__ = ["DEFAULT_TOPIC_PRESETS", "TopicPreset", "load_topic_presets"]
