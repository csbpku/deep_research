-- Pre-token content-review workers only had a timestamp lease. Requeue stale
-- rows that cannot be fenced by the new claim token. This changes no source
-- content; it only makes the review pipeline eligible for a fresh claim.
UPDATE "summaries"
SET
  "contentReviewStatus" = NULL,
  "contentReviewRound" = 0,
  "contentReviewSummary" = NULL,
  "contentReviewDetails" = NULL,
  "contentReviewStartedAt" = NULL,
  "contentReviewClaimId" = NULL,
  "contentReviewedAt" = NULL,
  "renderReviewStatus" = NULL,
  "renderReviewRound" = 0,
  "renderReviewSummary" = NULL,
  "renderReviewDetails" = NULL,
  "renderReviewStartedAt" = NULL,
  "renderReviewedAt" = NULL,
  "updatedAt" = now()
WHERE "distilledTier" IN ('collection', 'deep_read')
  AND "contentReviewStatus" = 'reviewing'
  AND "contentReviewClaimId" IS NULL
  AND "contentReviewStartedAt" < now() - interval '30 minutes';
