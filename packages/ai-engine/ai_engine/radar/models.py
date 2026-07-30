"""Shared radar source and candidate DTOs."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

SourceType = Literal[
    "github", "github_trending", "arxiv", "rss",
    "hackernews", "reddit", "lobsters", "devto",
    "producthunt", "sitemap_watch", "vendor_guides", "wechat",
    "github_topic_search", "huggingface_models",
]
ContentOrigin = Literal["api", "rss", "web"]


@dataclass(slots=True, frozen=True)
class RadarSource:
    """One enabled row from ``radar_sources``."""

    id: str
    name: str
    source_type: SourceType
    config: dict[str, Any]


@dataclass(slots=True, frozen=True)
class RadarCandidate:
    """Normalized source item before canonicalization and interpretation."""

    title: str
    url: str
    snippet: str = ""
    published_at: datetime | None = None
    content_origin: ContentOrigin = "api"
    tags: tuple[str, ...] = field(default_factory=tuple)
    source_quality_hint: float | None = None
    timeliness_hint: float | None = None
