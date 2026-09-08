-- A web brief is a markdown research artifact with an independent reader
-- presentation. It follows the same durable draft contract as a research
-- report and Slides; the presentation is selected at the read boundary.
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
          "reportType" = 'summary_brief'
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
