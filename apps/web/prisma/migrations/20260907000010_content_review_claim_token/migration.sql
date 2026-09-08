-- A review timestamp can reclaim stale work, but it is not enough to stop the
-- old reviewer from writing after a new reviewer takes over. Bind every
-- content-review write to a unique claim token, just like enrichment.
ALTER TABLE "summaries"
  ADD COLUMN "contentReviewClaimId" UUID;

CREATE INDEX "summaries_contentReviewClaimId_idx"
  ON "summaries" ("contentReviewClaimId");
