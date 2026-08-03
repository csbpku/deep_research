"""Lightweight noise-pattern filter — runs AFTER source-side prefiltering.

After Day 2 changes, all fetchers that need it (HN, Reddit, Dev.to, mixed RSS
feeds) now do source-side AI keyword filtering at fetch time. This module
keeps only the obvious-noise regex (job postings, promos, newsletters) so
``sync_runner.py`` doesn't accidentally insert clearly-junk rows that
Distilled v2 LLM scoring would correctly mark `tier=noise` — but at much
higher LLM cost per row.

Filter rules:
  1. Noise patterns in title (job, promo, AMA, newsletter, etc.) → skip
  2. PR soft article → tag only (not skip)

Note: relevance / timeliness / source_quality composite scoring is still
computed by ``ai_engine.radar.pipeline.score_candidate()`` and stored on
the Summary row, but it no longer gates insertion. The LLM-driven
Distilled v2 scorer (``ai_engine.radar.distilled_scorer``) is the quality
gate; ``_insert_candidate`` drops `tier=noise` rows after scoring.
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


@dataclass
class FilterResult:
    keep: bool
    reason: str
    is_pr: bool = False
    needs_embedding_rescue: bool = False


def filter_candidate(
    candidate: NormalizedCandidate,
    score: CandidateScore,
    source_type: str,
) -> FilterResult:
    """Return ``keep=True`` for everything except obvious noise.

    The score parameter is kept for API compatibility but no longer used
    to gate insertion — Distilled v2 LLM scoring is the sole quality gate.
    """
    title = candidate.title

    # Rule 1: noise patterns
    for pat in _NOISE_PATTERNS:
        if pat.search(title):
            return FilterResult(keep=False, reason=f"noise: {pat.pattern[:40]}")

    # Rule 2: PR soft article tag (does not filter)
    for pat in _PR_PATTERNS:
        if pat.search(title):
            return FilterResult(keep=True, reason=f"pr: {pat.pattern[:40]}", is_pr=True)

    return FilterResult(keep=True, reason="passed")


__all__ = ["FilterResult", "filter_candidate"]
