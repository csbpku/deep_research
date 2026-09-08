-- A pre-token render worker may have left a row in reviewing without a claim
-- UUID. It cannot be safely distinguished from a dead worker, so requeue it.
-- The second predicate also catches a legacy worker that finished after the
-- previous migration but still wrote an un-fenced terminal result.
UPDATE "summaries"
SET
  "renderReviewStatus" = 'queued',
  "renderReviewRound" = 0,
  "renderReviewSummary" = '{"status":"queued","reason":"LEGACY_RENDER_CLAIM_MISSING"}'::jsonb,
  "renderReviewDetails" = '{"status":"queued","reason":"LEGACY_RENDER_CLAIM_MISSING"}'::jsonb,
  "renderReviewStartedAt" = NULL,
  "renderReviewClaimId" = NULL,
  "renderReviewedAt" = NULL,
  "updatedAt" = now()
WHERE "distilledTier" IN ('collection', 'deep_read')
  AND (
    (
      "renderReviewStatus" = 'reviewing'
      AND "renderReviewClaimId" IS NULL
    )
    OR (
      "contentReviewStatus" IN ('approved', 'needs_manual_review')
      AND "renderReviewStatus" IN ('approved', 'needs_manual_review', 'unavailable')
      AND "renderReviewDetails"->>'contentSha256' IS DISTINCT FROM "originalSha256"
      AND COALESCE("originalMeta"->>'enrichmentVersion', '') = '2.0'
      AND COALESCE("originalMarkdown", '') <> ''
    )
  );
