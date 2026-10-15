import { RADAR_PUBLIC_SCORE_SQL } from './score-validity';

// Mirrored in ai_engine/radar/topic_eligibility.py; fixed summary alias s.
// Recheck persisted links at read time, including links created by an Admin.
export const TOPIC_ELIGIBILITY_SQL = `
COALESCE((
    s."status" IN ('candidate', 'published')
    AND s."distilledTier" IN ('collection', 'deep_read')
    AND NOT ('repo_digest' = ANY(s."tags"))
    AND COALESCE(s."originalKind", '') NOT IN ('github_issue', 'github_pr', 'github_release')
    AND s."canonicalUrl" NOT LIKE '%/issues/%'
    AND s."canonicalUrl" NOT LIKE '%/pull/%'
    AND s."canonicalUrl" NOT LIKE '%/releases/tag/%'
    AND (
        (s."source" = 'user' AND EXISTS (
            SELECT 1 FROM "share_submissions" share
            WHERE share."publishedSummaryId" = s."id" AND share."status" = 'approved'
        ))
        OR (
            s."source" = 'daily' AND s."syncRunId" IS NOT NULL
            AND s."distilledScore" IS NOT NULL
            AND ${RADAR_PUBLIC_SCORE_SQL}
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
`;
