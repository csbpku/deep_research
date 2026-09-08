-- Historical browser-review rows predate the snapshot hash in
-- renderReviewDetails. They are not evidence for the current body, so make
-- them explicitly re-reviewable without changing source or content-review
-- conclusions.
UPDATE "summaries"
SET
  "renderReviewStatus" = 'queued',
  "renderReviewRound" = 0,
  "renderReviewSummary" = '{"status":"queued","reason":"LEGACY_RENDER_HASH_MISSING"}'::jsonb,
  "renderReviewDetails" = '{"status":"queued","reason":"LEGACY_RENDER_HASH_MISSING"}'::jsonb,
  "renderReviewStartedAt" = NULL,
  "renderReviewClaimId" = NULL,
  "renderReviewedAt" = NULL,
  "updatedAt" = now()
WHERE "distilledTier" IN ('collection', 'deep_read')
  AND "contentReviewStatus" IN ('approved', 'needs_manual_review')
  AND "renderReviewStatus" IN ('approved', 'needs_manual_review', 'unavailable')
  AND "renderReviewDetails"->>'contentSha256' IS DISTINCT FROM "originalSha256"
  AND COALESCE("originalMeta"->>'enrichmentVersion', '') = '2.0'
  AND COALESCE("originalMarkdown", '') <> '';
