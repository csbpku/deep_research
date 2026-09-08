-- Post-enrichment browser presentation review for radar summaries.
-- Kept separate from Research/AiResearchJob review fields because this cycle
-- audits extracted Markdown/HTML rendering, not research-claim correctness.
ALTER TABLE "summaries"
  ADD COLUMN "contentReviewStatus" VARCHAR(32),
  ADD COLUMN "contentReviewRound" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "contentReviewSummary" JSONB,
  ADD COLUMN "contentReviewDetails" JSONB,
  ADD COLUMN "contentReviewedAt" TIMESTAMPTZ(3);

CREATE INDEX "summaries_contentReviewStatus_idx"
  ON "summaries" ("contentReviewStatus", "contentReviewedAt");
