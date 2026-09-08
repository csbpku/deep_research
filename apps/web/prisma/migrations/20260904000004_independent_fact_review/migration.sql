-- Fact review is a recoverable background stage, independent from the
-- research execution lease.  A timestamp lets a new worker reclaim a review
-- that was interrupted after it moved to reviewing.
ALTER TABLE "ai_research_jobs"
  ADD COLUMN "reviewStartedAt" TIMESTAMPTZ(3);

CREATE INDEX "ai_research_jobs_review_queue_idx"
  ON "ai_research_jobs" ("reviewStatus", "reviewStartedAt", "createdAt");
