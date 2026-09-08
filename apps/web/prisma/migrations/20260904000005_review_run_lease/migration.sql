-- Review runs have their own compare-and-set token.  This is separate from
-- the research execution lease because a report can be edited while an
-- asynchronous reviewer is still finishing.
ALTER TABLE "researches"
  ADD COLUMN "reviewStartedAt" TIMESTAMPTZ(3),
  ADD COLUMN "reviewRunToken" UUID;

ALTER TABLE "ai_research_jobs"
  ADD COLUMN "reviewRunToken" UUID;

CREATE INDEX "ai_research_jobs_review_run_token_idx"
  ON "ai_research_jobs" ("reviewRunToken");
