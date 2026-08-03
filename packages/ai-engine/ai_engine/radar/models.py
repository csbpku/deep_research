"""Shared radar source and candidate DTOs."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

SourceType = Literal[
    "github", "github_trending", "github_tracked", "arxiv", "rss",
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
    repo_activity: "RepoActivity | None" = None


@dataclass(slots=True, frozen=True)
class RepoActivityItem:
    """One issue/PR/release inside a tracked-repo daily digest."""

    kind: Literal["issue", "pr", "release"]
    number: str
    title: str
    url: str
    state: str = ""
    author: str = ""
    comments: int = 0
    labels: tuple[str, ...] = field(default_factory=tuple)
    reactions: int = 0
    created_at: str = ""
    updated_at: str = ""
    published_at: str = ""
    body: str = ""


@dataclass(slots=True, frozen=True)
class RepoActivity:
    """Structured recent activity for one tracked GitHub repo."""

    repo: str
    issues: tuple[RepoActivityItem, ...] = field(default_factory=tuple)
    prs: tuple[RepoActivityItem, ...] = field(default_factory=tuple)
    releases: tuple[RepoActivityItem, ...] = field(default_factory=tuple)

    @property
    def item_count(self) -> int:
        return len(self.issues) + len(self.prs) + len(self.releases)
