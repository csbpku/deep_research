"""Content-type routing for the radar 导读 (brief).

The brief asks different questions for different kinds of publication. Only
clear shapes are typed: mixed feeds keep the generic brief, because a single
RSS or Hacker News feed can contain essays, papers, releases and news alike.
The result is a prompt hint only; it is not a score, a tier or a stored field.
"""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

from ai_engine.scoring.scoring_profiles import (
    PROFILE_ENGINEERING,
    PROFILE_PAPER,
    PROFILE_NEWS,
    profile_for_source_url,
)

BriefKind = Literal["paper", "engineering", "project", "change"]

# Summary tag recorded when a typed brief was persisted, so later audits can
# separate typed briefs from generic ones without a schema change.
TYPED_BRIEF_TAG = "brief_typed_v1"

TYPED_BRIEF_QUESTIONS: dict[str, tuple[str, ...]] = {
    "engineering": (
        "这篇文章解决什么约束或问题",
        "关键机制是什么",
        "代价和局限是什么",
        "哪些场景可以迁移",
    ),
    "paper": (
        "相对已有基线新在哪里",
        "实验在什么条件下成立",
        "代码或数据是否可复现",
    ),
    "project": (
        "这个项目做什么",
        "集成与运行有哪些要求",
        "有哪些成熟度证据",
        "已知限制是什么",
    ),
    "change": (
        "具体变化是什么",
        "影响谁",
        "是否需要采取行动",
        "哪些内容仍是厂商说法或尚未确认",
    ),
}


def _is_release_url(url: str) -> bool:
    try:
        path = urlsplit(url or "").path.lower()
    except ValueError:
        return False
    return "/releases" in path


def radar_brief_kind(
    source_type: str,
    url: str | None,
    *,
    github_repo_candidate: bool = False,
) -> BriefKind | None:
    """Return the publication shape for brief prompting, or None for the generic brief."""
    normalized = (source_type or "").strip().lower()
    if _is_release_url(url or "") and normalized in {"github", "github_release", "vendor_changelog", "vendor_news"}:
        return "change"
    if github_repo_candidate or normalized == "huggingface_models":
        return "project"
    if normalized == "vendor_changelog":
        return "change"
    _profile, profile_id = profile_for_source_url(normalized, url)
    if profile_id == PROFILE_PAPER:
        return "paper"
    if normalized == "vendor_news" and profile_id == PROFILE_NEWS:
        return "change"
    if normalized in {"devto", "hn_algolia"}:
        return "engineering"
    # Documentation-shaped URLs inside mixed or vendor feeds are routed to the
    # engineering profile by profile_for_source_url; only those are typed.
    if profile_id == PROFILE_ENGINEERING and normalized in {"vendor_news", "rss", "sitemap_watch"}:
        return "engineering"
    return None
