"""Radar candidate normalization and explainable scoring.

v1.2 — Weighted topic taxonomy with word-boundary matching, inspired by
Distilled's approach (keyword-only filtering failed; the fix was to combine
topic relevance with source quality and timeliness in a composite score).

Key design decisions:
- Keywords are grouped into 3 tiers by signal strength (core / broad / soft).
- Short keywords (<=4 chars) use word-boundary regex to avoid false positives
  like "ai" matching "detail" or "available".
- Relevance is a weighted sum, not a flat count: a core keyword hit is worth
  more than a soft keyword hit.
- A topic gate (relevance >= 0.1) acts as a binary prefilter before the
  composite threshold, mirroring Distilled's "noise" tier.
"""

from __future__ import annotations

import re as _re
from dataclasses import dataclass
from datetime import datetime, timezone

from ai_engine.ingestion.pipeline import canonicalize_url
from ai_engine.radar.models import RadarCandidate, SourceType

SCORE_VERSION = "1.2"

# ── Weighted keyword taxonomy ──────────────────────────────────────────────
#
# Tier 1 (core, weight=3): specific AI/ML terms that almost always indicate
#   the content is directly relevant to our radar focus.
# Tier 2 (broad, weight=2): adjacent technical terms that suggest relevance
#   but could appear in non-AI contexts.
# Tier 3 (soft, weight=1): general tech terms that add signal but are
#   insufficient alone.
#
# Short keywords (<=4 ASCII chars) require word-boundary matching to avoid
# substring false positives (e.g. "ai" in "detail", "rag" in "paragraph").

_TIER1_KEYWORDS: tuple[str, ...] = (
    "agent", "llm", "rag", "mcp", "gpt", "claude",
    "transformer", "embedding", "langchain", "autogen",
    "crewai", "copilot", "chatbot", "diffusion",
    "fine-tune", "fine-tuning", "multimodal",
    "deep learning", "neural network", "machine learning",
    "computer vision", "large language model",
    "大模型", "智能体", "检索增强", "微调", "向量数据库",
)

_TIER2_KEYWORDS: tuple[str, ...] = (
    "inference", "prompt", "vector", "nlp",
    "open source", "开源",
    "transformers", "pytorch", "tensorflow",
    "huggingface", "hugging face",
    "openai", "anthropic", "deepmind",
    "reasoning", "benchmark",
    "token", "attention", "gradient",
    "alignment", "rlhf", "sft", "dpo",
    "vision language", "text-to-image",
    "知识图谱", "推理", "向量", "嵌入",
)

_TIER3_KEYWORDS: tuple[str, ...] = (
    "model", "training", "dataset", "gpu",
    "api", "framework", "deployment",
    "automation", "pipeline",
    "security", "privacy",
    "人工智能", "模型", "训练", "数据集",
)

# Pre-compile regex patterns for short keywords (<=4 ASCII chars).
# Longer keywords and all CJK keywords use plain substring matching.
_SHORT_KW_RE: dict[str, _re.Pattern[str]] = {}
for _kw in (_TIER1_KEYWORDS + _TIER2_KEYWORDS + _TIER3_KEYWORDS):
    _stripped = _kw.strip()
    # Word-boundary for short ASCII keywords only; CJK doesn't have \b
    if len(_stripped) <= 4 and not _re.search(r'[^\x00-\x7f]', _stripped):
        _SHORT_KW_RE[_kw] = _re.compile(
            r'(?<![a-z0-9])' + _re.escape(_stripped) + r'(?![a-z0-9])',
            _re.IGNORECASE,
        )

_TIER1_WEIGHT = 3.0
_TIER2_WEIGHT = 2.0
_TIER3_WEIGHT = 1.0
# Max possible raw score: assume 5 tier-1 hits (enough to saturate)
_MAX_RAW_SCORE = _TIER1_WEIGHT * 5


def _match_keyword(keyword: str, corpus: str) -> bool:
    """Match a keyword in corpus with word-boundary for short ASCII terms."""
    pattern = _SHORT_KW_RE.get(keyword)
    if pattern is not None:
        return bool(pattern.search(corpus))
    return keyword.lower() in corpus


def _compute_relevance(corpus: str) -> tuple[float, list[str]]:
    """Return (relevance_score 0.0-1.0, matched_keywords).

    Weighted sum with diminishing returns: each additional hit contributes
    less, so 1 strong hit is meaningful but 10 hits don't linearly scale.
    """
    matched: list[str] = []
    raw = 0.0

    for kw in _TIER1_KEYWORDS:
        if _match_keyword(kw, corpus):
            matched.append(kw)
            raw += _TIER1_WEIGHT
    for kw in _TIER2_KEYWORDS:
        if _match_keyword(kw, corpus):
            matched.append(kw)
            raw += _TIER2_WEIGHT
    for kw in _TIER3_KEYWORDS:
        if _match_keyword(kw, corpus):
            matched.append(kw)
            raw += _TIER3_WEIGHT

    # Diminishing returns: sqrt curve so first hit matters most
    relevance = min(1.0, (raw / _MAX_RAW_SCORE) ** 0.5)
    return relevance, matched


@dataclass(slots=True, frozen=True)
class NormalizedCandidate:
    title: str
    url: str
    canonical_url: str
    snippet: str
    published_at: datetime | None
    content_origin: str
    tags: tuple[str, ...]
    source_quality_hint: float | None


@dataclass(slots=True, frozen=True)
class CandidateScore:
    relevance: float
    timeliness: float
    source_quality: float
    version: str
    reason: str


def normalize_candidate(candidate: RadarCandidate) -> NormalizedCandidate:
    canonical = canonicalize_url(candidate.url)
    if not canonical:
        raise ValueError("candidate URL is not a valid HTTP(S) URL")
    title = " ".join(candidate.title.split()).strip()[:300]
    if not title:
        title = "Untitled"
    snippet = " ".join(candidate.snippet.split()).strip()[:2000]
    published = candidate.published_at
    if published is not None and published.tzinfo is None:
        published = published.replace(tzinfo=timezone.utc)
    return NormalizedCandidate(
        title=title,
        url=candidate.url[:2048],
        canonical_url=canonical[:2048],
        snippet=snippet,
        published_at=published,
        content_origin=candidate.content_origin,
        tags=tuple(dict.fromkeys(candidate.tags))[:20],
        source_quality_hint=candidate.source_quality_hint,
    )


_SOURCE_QUALITY_DEFAULTS: dict[str, float] = {
    "github": 0.85, "github_trending": 0.80,
    "arxiv": 0.90, "rss": 0.70,
    "hackernews": 0.80, "reddit": 0.70,
    "lobsters": 0.80, "devto": 0.65,
    "producthunt": 0.65, "vendor_news": 0.90,
    "wechat": 0.75,
}


def score_candidate(
    candidate: NormalizedCandidate,
    *,
    source_type: SourceType,
    now: datetime | None = None,
) -> CandidateScore:
    """Produce deterministic scores used for sorting only, never approval."""

    current = now or datetime.now(timezone.utc)
    corpus = f"{candidate.title} {candidate.snippet} {' '.join(candidate.tags)}".lower()
    relevance, matched = _compute_relevance(corpus)

    if candidate.published_at is None:
        timeliness = 0.45
        age_days: int | None = None
    else:
        published = candidate.published_at.astimezone(timezone.utc)
        age_days = max(0, int((current - published).total_seconds() // 86400))
        if age_days <= 1:
            timeliness = 1.0
        elif age_days <= 7:
            timeliness = 0.85
        elif age_days <= 30:
            timeliness = 0.65
        elif age_days <= 90:
            timeliness = 0.4
        else:
            timeliness = 0.2

    source_quality = candidate.source_quality_hint or _SOURCE_QUALITY_DEFAULTS.get(source_type, 0.70)
    source_quality = max(0.0, min(1.0, source_quality))

    kw_reason = ", ".join(matched[:5]) if matched else "未命中关键词"
    age_reason = f"发布约 {age_days} 天" if age_days is not None else "发布时间未知"
    reason = (
        f"相关性 {relevance:.2f}（{kw_reason}）；"
        f"时效 {timeliness:.2f}（{age_reason}）；"
        f"来源质量 {source_quality:.2f}（{source_type}）。仅用于排序，不自动发布。"
    )[:500]
    return CandidateScore(
        relevance=round(relevance, 4),
        timeliness=round(timeliness, 4),
        source_quality=round(source_quality, 4),
        version=SCORE_VERSION,
        reason=reason,
    )


__all__ = [
    "CandidateScore",
    "NormalizedCandidate",
    "SCORE_VERSION",
    "normalize_candidate",
    "score_candidate",
]
