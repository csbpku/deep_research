-- A worker identity identifies a process, but it is not unique per attempt.
-- A fresh claim token prevents a late coroutine from an earlier attempt in the
-- same process from overwriting a newer attempt after a lease is reclaimed.
ALTER TABLE "summaries"
  ADD COLUMN "enrichmentClaimId" UUID;

CREATE INDEX "summaries_enrichmentClaimId_idx"
  ON "summaries" ("enrichmentClaimId");
