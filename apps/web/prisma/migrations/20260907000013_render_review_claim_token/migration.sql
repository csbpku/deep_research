-- Fence browser-review results from a worker that was reclaimed and restarted
-- for the same snapshot and round.
ALTER TABLE "summaries"
  ADD COLUMN "renderReviewClaimId" UUID;

CREATE INDEX "summaries_renderReviewClaimId_idx"
  ON "summaries" ("renderReviewClaimId");

-- No pre-token worker can safely own an active claim. Existing terminal and
-- queued rows therefore start with an empty token; the next claim generates a
-- fresh UUID.
UPDATE "summaries"
SET "renderReviewClaimId" = NULL
WHERE "renderReviewStatus" IS DISTINCT FROM 'reviewing';
