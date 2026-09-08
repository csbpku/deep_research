-- Fact-review runs are an independent queue. Give each claim a short lease
-- so a restarted worker cannot strand a draft in "reviewing".
ALTER TABLE "research_review_runs"
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "heartbeatAt" TIMESTAMPTZ(3);

CREATE INDEX "research_review_runs_executionStatus_leaseExpiresAt_idx"
  ON "research_review_runs" ("executionStatus", "leaseExpiresAt");
