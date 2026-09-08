-- Persist the deterministic reader contract and make content review claims
-- recoverable after a worker restart.
ALTER TABLE "summaries"
  ADD COLUMN "readerQualityStatus" VARCHAR(32),
  ADD COLUMN "readerQualityDetails" JSONB,
  ADD COLUMN "readerQualityCheckedAt" TIMESTAMPTZ(3),
  ADD COLUMN "contentReviewStartedAt" TIMESTAMPTZ(3);

CREATE INDEX "summaries_readerQualityStatus_idx"
  ON "summaries" ("readerQualityStatus", "readerQualityCheckedAt");

CREATE INDEX "summaries_contentReviewLease_idx"
  ON "summaries" ("contentReviewStatus", "contentReviewStartedAt");
