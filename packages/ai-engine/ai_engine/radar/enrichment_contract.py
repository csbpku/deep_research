"""Shared persistence rules for radar enrichment writes.

An enrichment write replaces the reader snapshot.  Any review result attached
to the previous snapshot is therefore invalid until the new snapshot has been
checked again.  Keeping this SQL fragment in one small dependency-free module
makes every writer apply the same conservative invalidation atomically.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

ENRICHMENT_TIERS = frozenset({"collection", "deep_read"})


def _json_bool(value: object) -> bool:
    """Interpret JSON booleans consistently across DB and Python payloads."""
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def is_enrichment_tier(value: object) -> bool:
    """Return whether a tier promises a full reader asset."""
    return str(value or "") in ENRICHMENT_TIERS


def _as_dict(value: object) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, Mapping):
        return dict(value)
    return None


def github_zread_is_complete(original_meta: object) -> bool:
    """Validate the persisted Zread contract for a GitHub repository."""
    meta = _as_dict(original_meta) or {}
    zread = _as_dict(meta.get("zread")) or {}
    missing_pages = zread.get("missingPages")
    if (
        meta.get("enrichmentVersion") != "2.0"
        or zread.get("provider") == "github-readme-fallback"
        or zread.get("status") != "complete"
        or _json_bool(zread.get("truncated"))
        or ("missingPages" in zread and not isinstance(missing_pages, list))
        or (isinstance(missing_pages, list) and bool(missing_pages))
        or _json_bool(zread.get("mixedCommits"))
    ):
        return False
    pages = zread.get("pages")
    if not isinstance(pages, list) or not pages:
        return False
    page_count_raw = zread.get("pageCount")
    expected_page_count_raw = zread.get("expectedPageCount")
    if page_count_raw is None or expected_page_count_raw is None:
        return False
    try:
        page_count = int(page_count_raw)
        expected_page_count = int(expected_page_count_raw)
    except (TypeError, ValueError):
        return False
    return expected_page_count <= 0 or page_count >= expected_page_count


def is_enrichment_ready(
    *,
    enrichment_status: object,
    reader_quality_status: object,
    original_kind: object,
    original_meta: object,
) -> bool:
    """Return whether a row can expose a high-value reading tier."""
    if enrichment_status != "ready" or reader_quality_status != "ready":
        return False
    meta = _as_dict(original_meta) or {}
    if meta.get("enrichmentVersion") != "2.0":
        return False
    if str(original_kind or "") == "github_repo":
        return github_zread_is_complete(meta)
    return True


def effective_tier(
    target_tier: object,
    *,
    enrichment_ready: bool,
) -> str | None:
    """Map a scored tier to the tier that is safe to expose right now."""
    target = str(target_tier or "") or None
    if target is None:
        return None
    if is_enrichment_tier(target) and not enrichment_ready:
        return "skim"
    return target


def initial_enrichment_status(distilled_tier: str | None) -> str | None:
    """Return the durable queue state for a newly scored radar summary."""
    return "pending" if distilled_tier in ENRICHMENT_TIERS else None


def enrichment_review_reset_assignments() -> str:
    """Return SQL assignments that invalidate reviews for a new snapshot.

    The returned fragment has no leading comma.  Callers append it to the
    other assignments in the same ``UPDATE`` statement.
    """
    return (
        '"readerQualityStatus" = NULL, '
        '"readerQualityDetails" = NULL, '
        '"readerQualityCheckedAt" = NULL, '
        '"contentReviewStatus" = NULL, '
        '"contentReviewRound" = 0, '
        '"contentReviewSummary" = NULL, '
        '"contentReviewDetails" = NULL, '
        '"contentReviewStartedAt" = NULL, '
        '"contentReviewClaimId" = NULL, '
        '"contentReviewedAt" = NULL, '
        '"renderReviewStatus" = NULL, '
        '"renderReviewRound" = 0, '
        '"renderReviewSummary" = NULL, '
        '"renderReviewDetails" = NULL, '
        '"renderReviewStartedAt" = NULL, '
        '"renderReviewClaimId" = NULL, '
        '"renderReviewedAt" = NULL, '
        '"tags" = array_append('
        'array_remove(array_remove(COALESCE("tags", ARRAY[]::text[]), '
        "'content_pending'), 'github_content_pending'), 'content_pending')"
    )


__all__ = [
    "ENRICHMENT_TIERS",
    "effective_tier",
    "enrichment_review_reset_assignments",
    "github_zread_is_complete",
    "initial_enrichment_status",
    "is_enrichment_ready",
    "is_enrichment_tier",
]
