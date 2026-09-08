-- A deep run can finish writing while its fact-review request is still in
-- flight. Persist that readable checkpoint before the job becomes terminal,
-- so a worker restart or lease recovery does not erase the report.

ALTER TABLE "ai_research_jobs"
  DROP CONSTRAINT "ai_jobs_draft_matches_status";

ALTER TABLE "ai_research_jobs"
  ADD CONSTRAINT "ai_jobs_draft_matches_status"
  CHECK (
    (
      "status" = 'succeeded'
      AND (
        (
          "reportType" = 'research_report'
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
          "reportType" = 'summary_brief'
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
