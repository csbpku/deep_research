"""Shared reader-facing eligibility for topic discovery and synthesis.

External-reading candidates have a discovery score rather than a persisted
article. Legacy server-reading candidates still require the full review gate.
Every caller aliases summaries as ``s``. COALESCE makes stale-link removal
safe for nullable legacy state, including under NOT.
"""

from ai_engine.radar.score_validity import RADAR_PUBLIC_SCORE_SQL

TOPIC_ELIGIBILITY_SQL = f"""
COALESCE((
    s."status" IN ('candidate', 'published')
    AND s."distilledTier" IN ('collection', 'deep_read')
    AND NOT ('repo_digest' = ANY(s."tags"))
    AND COALESCE(s."originalKind", '') NOT IN ('github_issue', 'github_pr', 'github_release')
    AND s."canonicalUrl" NOT LIKE '%%/issues/%%'
    AND s."canonicalUrl" NOT LIKE '%%/pull/%%'
    AND s."canonicalUrl" NOT LIKE '%%/releases/tag/%%'
    AND (
        (s."source" = 'user' AND EXISTS (
            SELECT 1 FROM "share_submissions" share
            WHERE share."publishedSummaryId" = s."id" AND share."status" = 'approved'
        ))
        OR (
            s."source" = 'daily' AND s."syncRunId" IS NOT NULL
            AND s."distilledScore" IS NOT NULL
            AND {RADAR_PUBLIC_SCORE_SQL}
            AND (
                'external_reading' = ANY(s."tags")
                OR (
                    s."enrichmentStatus" = 'ready'
                    AND s."readerQualityStatus" = 'ready'
                    AND s."contentReviewStatus" = 'approved'
                )
            )
        )
    )
), false)
"""
