"""Radar candidate normalization and explainable three-dimensional scoring."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from ai_engine.ingestion.pipeline import canonicalize_url
from ai_engine.radar.models import RadarCandidate, SourceType

SCORE_VERSION = "1.0"
_DEFAULT_KEYWORDS = (
    "ai",
    "agent",
    "llm",
    "rag",
    "machine learning",
    "人工智能",
    "大模型",
    "智能体",
    "检索",
)


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


def score_candidate(
    candidate: NormalizedCandidate,
    *,
    source_type: SourceType,
    now: datetime | None = None,
    keywords: tuple[str, ...] = _DEFAULT_KEYWORDS,
) -> CandidateScore:
    """Produce deterministic scores used for sorting only, never approval."""

    current = now or datetime.now(timezone.utc)
    corpus = f"{candidate.title} {candidate.snippet} {' '.join(candidate.tags)}".lower()
    matched = [keyword for keyword in keywords if keyword.lower() in corpus]
    relevance = min(1.0, 0.25 + 0.15 * len(matched))

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

    defaults = {"github": 0.85, "arxiv": 0.9, "rss": 0.7}
    source_quality = candidate.source_quality_hint or defaults[source_type]
    source_quality = max(0.0, min(1.0, source_quality))
    keyword_reason = ", ".join(matched[:3]) if matched else "未命中预置关键词"
    age_reason = f"发布约 {age_days} 天" if age_days is not None else "发布时间未知"
    reason = (
        f"相关性 {relevance:.2f}（{keyword_reason}）；"
        f"时效 {timeliness:.2f}（{age_reason}）；"
        f"来源质量 {source_quality:.2f}（{source_type} 预置源）。仅用于排序，不自动发布。"
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
