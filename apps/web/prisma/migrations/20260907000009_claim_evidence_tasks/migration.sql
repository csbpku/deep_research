-- Claim-scoped evidence collection is separate from both human dispositions
-- and ordinary fact-review reruns. The job searches for new material; when it
-- completes, the Web boundary merges the evidence and queues a new review run.
CREATE TABLE "research_evidence_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "researchId" UUID NOT NULL,
  "aiResearchJobId" UUID NOT NULL,
  "claimId" VARCHAR(160) NOT NULL,
  "revisionHash" CHAR(64) NOT NULL,
  "claimText" TEXT NOT NULL,
  "searchInstruction" TEXT,
  "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
  "sourceCount" INTEGER NOT NULL DEFAULT 0,
  "reviewRunId" UUID,
  "result" JSONB,
  "errorCode" VARCHAR(64),
  "errorMessage" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_evidence_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_evidence_tasks_research_fkey"
    FOREIGN KEY ("researchId") REFERENCES "researches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "research_evidence_tasks_job_fkey"
    FOREIGN KEY ("aiResearchJobId") REFERENCES "ai_research_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "research_evidence_tasks_review_run_fkey"
    FOREIGN KEY ("reviewRunId") REFERENCES "research_review_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "research_evidence_tasks_status_check"
    CHECK ("status" IN ('queued', 'researching', 'evidence_ready', 'review_queued', 'completed', 'failed', 'stale')),
  CONSTRAINT "research_evidence_tasks_source_count_check"
    CHECK ("sourceCount" >= 0)
);

CREATE UNIQUE INDEX "research_evidence_tasks_aiResearchJobId_key"
  ON "research_evidence_tasks" ("aiResearchJobId");
-- At most one active retrieval may target the same claim in the same
-- research revision. The API still returns the existing task on a retry.
CREATE UNIQUE INDEX "research_evidence_tasks_one_active_claim_idx"
  ON "research_evidence_tasks" ("researchId", "claimId", "revisionHash")
  WHERE "status" IN ('queued', 'researching', 'evidence_ready', 'review_queued');
CREATE INDEX "research_evidence_tasks_research_claim_created_idx"
  ON "research_evidence_tasks" ("researchId", "claimId", "createdAt" DESC);
CREATE INDEX "research_evidence_tasks_status_created_idx"
  ON "research_evidence_tasks" ("status", "createdAt" ASC);
CREATE INDEX "research_evidence_tasks_review_run_idx"
  ON "research_evidence_tasks" ("reviewRunId");

CREATE OR REPLACE FUNCTION set_research_evidence_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER research_evidence_tasks_updated_at
BEFORE UPDATE ON "research_evidence_tasks"
FOR EACH ROW EXECUTE FUNCTION set_research_evidence_tasks_updated_at();

-- evidence_search is an internal retrieval receipt: it succeeds with inline
-- output and captured sources, but never owns a Research draft.
ALTER TABLE "ai_research_jobs"
  DROP CONSTRAINT "ai_jobs_draft_matches_status";

ALTER TABLE "ai_research_jobs"
  ADD CONSTRAINT "ai_jobs_draft_matches_status"
  CHECK (
    (
      "status" = 'succeeded'
      AND (
        (
          "reportType" IN ('research_report', 'web_brief')
          AND "artifactType" = 'markdown'
          AND "draftResearchId" IS NOT NULL
          AND "outputText" IS NULL
        )
        OR (
          "reportType" = 'slides'
          AND "artifactType" = 'slides'
          AND "draftResearchId" IS NOT NULL
          AND "outputText" IS NULL
        )
        OR (
          "reportType" IN ('summary_brief', 'evidence_search')
          AND "artifactType" = 'markdown'
          AND "draftResearchId" IS NULL
          AND "outputText" IS NOT NULL
          AND btrim("outputText") <> ''
        )
      )
    )
    OR (
      "status" = 'partial'
      AND "draftResearchId" IS NULL
      AND ("outputText" IS NULL OR btrim("outputText") <> '')
    )
    OR (
      "status" = 'running'
      AND "draftResearchId" IS NULL
      AND ("outputText" IS NULL OR btrim("outputText") <> '')
    )
    OR (
      "status" NOT IN ('succeeded', 'partial', 'running')
      AND "draftResearchId" IS NULL
      AND "outputText" IS NULL
    )
  );

ALTER TABLE "ai_research_jobs"
  DROP CONSTRAINT "ai_jobs_partial_sources_valid";

ALTER TABLE "ai_research_jobs"
  ADD CONSTRAINT "ai_jobs_partial_sources_valid"
  CHECK (
    jsonb_typeof("partialSources") = 'array'
    AND (
      ("status" = 'partial' AND jsonb_array_length("partialSources") >= 3)
      OR (
        "status" = 'succeeded'
        AND "reportType" IN ('research_report', 'slides', 'web_brief', 'evidence_search')
        AND jsonb_array_length("partialSources") >= 1
      )
      OR ("status" = 'succeeded' AND "reportType" = 'summary_brief')
      OR ("status" NOT IN ('partial', 'succeeded'))
    )
  );
