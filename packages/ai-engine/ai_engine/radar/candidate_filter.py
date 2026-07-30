"""Lightweight rule-based candidate filter — skip low-quality articles before LLM.

Inspired by Distilled's two-stage approach: heuristic prefilter before any
LLM call. The filter uses a topic gate (relevance must be > 0) combined with
a per-source-type composite threshold.

Filter rules:
  1. Noise patterns in title (job, promo, AMA, etc.) → skip
  2. Relevance == 0 (no keyword match at all) → skip for high-noise sources
  3. Composite score < threshold → skip
  4. PR soft article → tag only (not skip)

Composite formula: relevance * 0.35 + timeliness * 0.30 + source_quality * 0.35
"""

from __future__ import annotations

import re as _re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ai_engine.radar.pipeline import CandidateScore, NormalizedCandidate

_NOISE_PATTERNS: list[_re.Pattern[str]] = [
    _re.compile(r"^(job|hire|招聘|求职|interview)\b", _re.IGNORECASE),
    _re.compile(r"^(deal|discount|coupon|sale|促销|首发)\b", _re.IGNORECASE),
    _re.compile(r"^(sponsored|promoted|partner|广告|推广)\b", _re.IGNORECASE),
    _re.compile(r"^(webinar|workshop|meetup)\b", _re.IGNORECASE),
    _re.compile(r"^(newsletter|周刊|周报|月报)\b", _re.IGNORECASE),
    _re.compile(r"^(AMA|ask me anything|求助|help)\b", _re.IGNORECASE),
]

_PR_PATTERNS: list[_re.Pattern[str]] = [
    _re.compile(r"(获得|完成).*融资", _re.IGNORECASE),
    _re.compile(r"(入选|荣获|获奖|上榜)", _re.IGNORECASE),
    _re.compile(r"正式发布|全新升级|重磅推出", _re.IGNORECASE),
]

# Sources where zero keyword match = almost certainly noise.
# These are high-volume community feeds where most content is off-topic.
_STRICT_TOPIC_GATE: frozenset[str] = frozenset({
    "hackernews", "lobsters", "reddit", "devto",
    "rss", "producthunt",
})

# Sources where zero keyword match is acceptable (already pre-filtered
# or inherently topically relevant).
_LENIENT_TOPIC_GATE: frozenset[str] = frozenset({
    "arxiv", "vendor_news", "wechat",
})

# Composite thresholds calibrated for v1.2 scoring (relevance uses sqrt curve).
# A single tier-1 hit gives relevance ~0.77; a single tier-2 hit ~0.63.
_THRESHOLDS: dict[str, float] = {
    "hackernews": 0.55,
    "reddit": 0.52,
    "lobsters": 0.55,
    "devto": 0.50,
    "github": 0.48,
    "github_trending": 0.48,
    "arxiv": 0.40,
    "producthunt": 0.58,
    "rss": 0.50,
    "vendor_news": 0.35,
    "wechat": 0.42,
}

_DEFAULT_THRESHOLD = 0.50


@dataclass
class FilterResult:
    keep: bool
    reason: str
    is_pr: bool = False
    needs_embedding_rescue: bool = False


def _composite(score: CandidateScore) -> float:
    return score.relevance * 0.35 + score.timeliness * 0.30 + score.source_quality * 0.35


def filter_candidate(
    candidate: NormalizedCandidate,
    score: CandidateScore,
    source_type: str,
) -> FilterResult:
    title = candidate.title

    # Rule 1: noise patterns
    for pat in _NOISE_PATTERNS:
        if pat.search(title):
            return FilterResult(keep=False, reason=f"noise: {pat.pattern[:40]}")

    # Rule 2: topic gate — zero relevance means no keyword matched at all.
    # High-quality sources get a second chance via embedding rescue (Stage 1b).
    if score.relevance == 0.0 and source_type not in _LENIENT_TOPIC_GATE:
        if score.source_quality >= 0.70:
            return FilterResult(
                keep=False,
                reason=f"topic_gate: no keyword match ({source_type}), flagged for embedding rescue",
                needs_embedding_rescue=True,
            )
        return FilterResult(
            keep=False,
            reason=f"topic_gate: no keyword match ({source_type})",
        )

    # Rule 3: composite threshold
    composite = _composite(score)
    threshold = _THRESHOLDS.get(source_type, _DEFAULT_THRESHOLD)
    if composite < threshold:
        return FilterResult(
            keep=False,
            reason=f"composite {composite:.2f} < {threshold:.2f} "
                   f"(rel={score.relevance:.2f}, time={score.timeliness:.2f}, "
                   f"qual={score.source_quality:.2f})",
        )

    # Rule 4: PR soft article tag
    for pat in _PR_PATTERNS:
        if pat.search(title):
            return FilterResult(keep=True, reason=f"pr: {pat.pattern[:40]}", is_pr=True)

    return FilterResult(keep=True, reason="passed")


__all__ = ["FilterResult", "filter_candidate"]
