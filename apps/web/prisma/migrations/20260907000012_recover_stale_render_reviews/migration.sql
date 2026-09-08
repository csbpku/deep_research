-- Recover browser-review rows left in reviewing by a dead worker. Round one
-- can be retried; round two is closed as unavailable rather than remaining
-- indefinitely in an active-looking state.
UPDATE "summaries"
SET
  "renderReviewStatus" = CASE
    WHEN "renderReviewRound" >= 2 THEN 'unavailable'
    ELSE 'queued'
  END,
  "renderReviewSummary" = CASE
    WHEN "renderReviewRound" >= 2 THEN
      '{"status":"unavailable","message":"浏览器审核 worker lease 过期，已达到最大审核轮次。","reason":"WORKER_LOST"}'::jsonb
    ELSE
      '{"status":"queued","message":"浏览器审核 worker lease 过期，已重新排队。","reason":"WORKER_LOST"}'::jsonb
  END,
  "renderReviewDetails" = CASE
    WHEN "renderReviewRound" >= 2 THEN
      '{"status":"unavailable","reason":"WORKER_LOST"}'::jsonb
    ELSE
      '{"status":"queued","reason":"WORKER_LOST"}'::jsonb
  END,
  "renderReviewStartedAt" = NULL,
  "renderReviewedAt" = CASE
    WHEN "renderReviewRound" >= 2 THEN now()
    ELSE NULL
  END,
  "updatedAt" = now()
WHERE "distilledTier" IN ('collection', 'deep_read')
  AND "renderReviewStatus" = 'reviewing'
  AND "renderReviewStartedAt" < now() - interval '30 minutes';
