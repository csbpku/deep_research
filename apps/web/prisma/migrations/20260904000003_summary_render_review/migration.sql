-- Real-browser presentation review for enriched radar summaries.
-- Only collection/deep_read rows are queued by the enrichment worker.
ALTER TABLE "summaries"
  ADD COLUMN "renderReviewStatus" VARCHAR(32),
  ADD COLUMN "renderReviewRound" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "renderReviewSummary" JSONB,
  ADD COLUMN "renderReviewDetails" JSONB,
  ADD COLUMN "renderReviewStartedAt" TIMESTAMPTZ(3),
  ADD COLUMN "renderReviewedAt" TIMESTAMPTZ(3);

CREATE INDEX "summaries_renderReviewStatus_idx"
  ON "summaries" ("renderReviewStatus", "renderReviewedAt");
