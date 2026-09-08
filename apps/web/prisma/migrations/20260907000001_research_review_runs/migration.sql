-- A review is a version-scoped assessment, not a mutable property of a
-- research row.  Keep the legacy review* columns as compatibility mirrors
-- while this table becomes the durable queue and audit history.
CREATE TABLE "research_review_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "researchId" UUID NOT NULL,
  "aiResearchJobId" UUID,
  "revisionHash" CHAR(64) NOT NULL,
  "sourceSnapshotHash" CHAR(64) NOT NULL,
  "policyVersion" VARCHAR(40) NOT NULL DEFAULT 'fact-review-v1',
  "executionStatus" VARCHAR(24) NOT NULL DEFAULT 'queued',
  "outcome" VARCHAR(24),
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "summary" JSONB,
  "claims" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "details" JSONB,
  "triggeredBy" VARCHAR(32) NOT NULL DEFAULT 'system',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_review_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_review_runs_researchId_fkey"
    FOREIGN KEY ("researchId") REFERENCES "researches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "research_review_runs_aiResearchJobId_fkey"
    FOREIGN KEY ("aiResearchJobId") REFERENCES "ai_research_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "research_review_runs_executionStatus_check"
    CHECK ("executionStatus" IN ('queued', 'reviewing', 'completed', 'unavailable', 'stale')),
  CONSTRAINT "research_review_runs_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('clear', 'attention', 'blocked', 'insufficient', 'unavailable', 'stale'))
);

CREATE INDEX "research_review_runs_researchId_createdAt_idx"
  ON "research_review_runs" ("researchId", "createdAt" DESC);
CREATE INDEX "research_review_runs_executionStatus_createdAt_idx"
  ON "research_review_runs" ("executionStatus", "createdAt" ASC);
CREATE INDEX "research_review_runs_aiResearchJobId_idx"
  ON "research_review_runs" ("aiResearchJobId");
