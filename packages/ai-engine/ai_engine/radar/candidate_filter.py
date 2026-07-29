"""Lightweight rule-based candidate filter — skip low-quality articles before LLM.

Filter rules:
  - composite score < threshold → skip
  - known noise patterns in title → skip
  - PR soft article → tag only (not skip)

Thresholds by source type:
  - vendor_news: 0.30 (vendor official, high trust)
  - hackernews / lobsters / github_trending / arxiv: 0.35
  - devto / reddit / wechat: 0.40
  - rss (unaudited): 0.45
  - producthunt: 0.50
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

_THRESHOLDS: dict[str, float] = {
    "hackernews": 0.35,
    "reddit": 0.40,
    "lobsters": 0.35,
    "devto": 0.40,
    "github": 0.35,
    "github_trending": 0.35,
    "arxiv": 0.35,
    "producthunt": 0.50,
    "rss": 0.45,
    "vendor_news": 0.30,
    "wechat": 0.40,
}

_DEFAULT_THRESHOLD = 0.45


@dataclass
class FilterResult:
    keep: bool
    reason: str
    is_pr: bool = False


def _composite(score: CandidateScore) -> float:
    return score.relevance * 0.35 + score.timeliness * 0.30 + score.source_quality * 0.35


def filter_candidate(
    candidate: NormalizedCandidate,
    score: CandidateScore,
    source_type: str,
) -> FilterResult:
    title = candidate.title

    for pat in _NOISE_PATTERNS:
        if pat.search(title):
            return FilterResult(keep=False, reason=f"noise: {pat.pattern[:40]}")

    composite = _composite(score)
    threshold = _THRESHOLDS.get(source_type, _DEFAULT_THRESHOLD)
    if composite < threshold:
        return FilterResult(
            keep=False,
            reason=f"composite {composite:.2f} < {threshold:.2f} "
                   f"(rel={score.relevance:.2f}, time={score.timeliness:.2f}, "
                   f"qual={score.source_quality:.2f})",
        )

    for pat in _PR_PATTERNS:
        if pat.search(title):
            return FilterResult(keep=True, reason=f"pr: {pat.pattern[:40]}", is_pr=True)

    return FilterResult(keep=True, reason="passed")


__all__ = ["FilterResult", "filter_candidate"]
