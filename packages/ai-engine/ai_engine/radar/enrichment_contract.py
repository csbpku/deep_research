"""Shared persistence rules for radar enrichment writes.

An enrichment write replaces the reader snapshot.  Any review result attached
to the previous snapshot is therefore invalid until the new snapshot has been
checked again.  Keeping this SQL fragment in one small dependency-free module
makes every writer apply the same conservative invalidation atomically.
"""

from __future__ import annotations


ENRICHMENT_TIERS = frozenset({"collection", "deep_read"})


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
    "enrichment_review_reset_assignments",
    "initial_enrichment_status",
]
