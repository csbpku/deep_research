"""Scoring profiles for audience-matched Distilled scoring (v2).

Defines how the 7-dimension scoring weights, must_read thresholds, and
tier behavior shift per audience profile. Profiles are pure data — no
LLM calls happen here. The active profile is selected at runtime via
``active_profile()`` (overridable with the ``SCORING_PROFILE`` env var).

Profiles:
- ``paper``: peer-reviewed AI research. Heavy on 分析深度 / 信息增量,
  relaxed on 时效性 / 受众匹配度. Audience: researchers, grad students.
- ``engineering``: AI engineering and tooling. Balanced toward
  可行动性 / 信息增量, with strong 时效性. Audience: practitioners.
- ``news``: industry news and announcements. High 时效性 / 表达质量,
  信息增量 looser. Audience: product managers / content creators.

Compatibility:
- Old profile value ``tech_blog`` maps to ``engineering`` for backward
  compatibility with v1 deployments that pre-set SCORING_PROFILE.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


# ── Profile IDs ────────────────────────────────────────────────────

PROFILE_PAPER = "paper"
PROFILE_ENGINEERING = "engineering"
PROFILE_NEWS = "news"
# Backward-compatible alias for v1 deployments that pre-set the env var.
PROFILE_LEGACY_TECH_BLOG = "tech_blog"


# ── Dimension names (Chinese — keep aligned with rubric in prompt) ─
#
# The 7-dimension rubric is fixed across profiles (so a single prompt
# block can be reused); only the weights change per profile. The names
# below are the canonical keys used in:
#   - the JSON output of the LLM (Chinese keys for prompt simplicity)
#   - the dimension_scores dict on DistilledScore (still Chinese keys)
#   - profile.weights (Chinese keys)
#
# See ``distilled_scorer.DIMENSIONS`` for the authoritative list.

_DIM_INFO_INCREMENT = "信息增量"
_DIM_ANALYSIS_DEPTH = "分析深度"
_DIM_ACTIONABILITY = "可行动性"
_DIM_FACT_CREDIBILITY = "事实可信度"
_DIM_TIMELINESS = "时效性"
_DIM_EXPRESSION = "表达质量"
_DIM_AUDIENCE_FIT = "综合信号"


# ── Profile definition ─────────────────────────────────────────────


@dataclass(frozen=True)
class ScoringProfile:
    """A scoring profile: weights + must_read thresholds + tier thresholds."""

    id: str
    description: str
    # Dimension name → weight (0–100). Sum must equal 100.
    weights: dict[str, int]
    # Tier thresholds (collection, deep_read, skim). Noise is everything below.
    tier_collection: float
    tier_deep_read: float
    tier_skim: float
    # must_read total floor
    must_read_total: float
    # minimum number of "core" dimensions (信息增量/分析深度/可行动性) at
    # ≥ 2 to qualify for must_read.
    must_read_core_count: int


# Core dimensions used for must_read counting. Fixed across all profiles.
_CORE_DIMENSIONS: tuple[str, ...] = (
    _DIM_INFO_INCREMENT,
    _DIM_ANALYSIS_DEPTH,
    _DIM_ACTIONABILITY,
)


PAPER_PROFILE = ScoringProfile(
    id=PROFILE_PAPER,
    description=(
        "Peer-reviewed AI/ML research (arxiv papers, conference proceedings). "
        "Audience: researchers, graduate students. Reward depth and novelty; "
        "relax timeliness and broad audience appeal."
    ),
    weights={
        _DIM_INFO_INCREMENT: 30,
        _DIM_ANALYSIS_DEPTH: 30,
        _DIM_ACTIONABILITY: 10,
        _DIM_FACT_CREDIBILITY: 15,
        _DIM_TIMELINESS: 5,
        _DIM_EXPRESSION: 5,
        _DIM_AUDIENCE_FIT: 5,
    },
    tier_collection=82,
    tier_deep_read=68,
    tier_skim=52,
    must_read_total=85,
    must_read_core_count=2,
)


ENGINEERING_PROFILE = ScoringProfile(
    id=PROFILE_ENGINEERING,
    description=(
        "AI engineering and tooling articles (frameworks, deployment, "
        "infra, code-level tutorials). Audience: AI engineers, MLOps, "
        "backend/platform engineers. Reward actionability and novelty."
    ),
    weights={
        _DIM_INFO_INCREMENT: 25,
        _DIM_ANALYSIS_DEPTH: 20,
        _DIM_ACTIONABILITY: 25,
        _DIM_FACT_CREDIBILITY: 10,
        _DIM_TIMELINESS: 10,
        _DIM_EXPRESSION: 5,
        _DIM_AUDIENCE_FIT: 5,
    },
    tier_collection=85,
    tier_deep_read=70,
    tier_skim=55,
    must_read_total=88,
    must_read_core_count=2,
)


NEWS_PROFILE = ScoringProfile(
    id=PROFILE_NEWS,
    description=(
        "Industry news, product launches, market announcements. "
        "Audience: product managers, content creators, executives. "
        "Reward timeliness and clarity; relax information density."
    ),
    weights={
        _DIM_INFO_INCREMENT: 15,
        _DIM_ANALYSIS_DEPTH: 10,
        _DIM_ACTIONABILITY: 10,
        _DIM_FACT_CREDIBILITY: 15,
        _DIM_TIMELINESS: 25,
        _DIM_EXPRESSION: 10,
        _DIM_AUDIENCE_FIT: 15,
    },
    tier_collection=82,
    tier_deep_read=68,
    tier_skim=55,
    must_read_total=85,
    must_read_core_count=1,
)


_PROFILES: dict[str, ScoringProfile] = {
    PROFILE_PAPER: PAPER_PROFILE,
    PROFILE_ENGINEERING: ENGINEERING_PROFILE,
    PROFILE_NEWS: NEWS_PROFILE,
    # Legacy v1 alias — same behavior as engineering.
    PROFILE_LEGACY_TECH_BLOG: ENGINEERING_PROFILE,
}


# ── Public helpers ────────────────────────────────────────────────


def get_profile(profile_id: str) -> ScoringProfile:
    """Look up a profile by id.

    Unknown ids fall back to ``engineering`` so a typo in env config
    never breaks the radar scoring run. ``tech_blog`` (the v1 default)
    is treated as a legacy alias for ``engineering``.
    """
    if not profile_id:
        raise ValueError("profile_id must be non-empty")
    return _PROFILES.get(profile_id, ENGINEERING_PROFILE)


def active_profile() -> ScoringProfile:
    """Resolve the active profile from ``SCORING_PROFILE`` env var.

    Resolution order:
    1. ``SCORING_PROFILE`` env var (if set, including legacy ``tech_blog``)
    2. Fall back to ``engineering`` (the default v1 profile).

    Unknown ids fall back to engineering so a typo in env config never
    breaks the radar scoring run.
    """
    raw = os.environ.get("SCORING_PROFILE", "").strip()
    if not raw:
        return ENGINEERING_PROFILE
    return get_profile(raw)


def list_profiles() -> tuple[ScoringProfile, ...]:
    """Return all known profiles (excluding the legacy alias)."""
    return (PAPER_PROFILE, ENGINEERING_PROFILE, NEWS_PROFILE)


__all__ = [
    "ENGINEERING_PROFILE",
    "NEWS_PROFILE",
    "PAPER_PROFILE",
    "PROFILE_ENGINEERING",
    "PROFILE_LEGACY_TECH_BLOG",
    "PROFILE_NEWS",
    "PROFILE_PAPER",
    "ScoringProfile",
    "active_profile",
    "get_profile",
    "list_profiles",
]