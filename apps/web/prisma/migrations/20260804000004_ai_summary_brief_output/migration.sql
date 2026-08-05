-- Keep lightweight summary output on the AI job itself. Unlike a research
-- report, summary_brief must not create a Research draft.

ALTER TABLE "ai_research_jobs"
  ADD COLUMN "outputText" TEXT;

ALTER TABLE "ai_research_jobs"
  DROP CONSTRAINT "ai_jobs_draft_matches_status",
  DROP CONSTRAINT "ai_jobs_partial_sources_valid";

ALTER TABLE "ai_research_jobs"
  ADD CONSTRAINT "ai_jobs_draft_matches_status"
  CHECK (
    (
      "status" = 'succeeded'
      AND (
        (
          "reportType" = 'research_report'
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
      "status" <> 'succeeded'
      AND "draftResearchId" IS NULL
      AND "outputText" IS NULL
    )
  ),
  ADD CONSTRAINT "ai_jobs_partial_sources_valid"
  CHECK (
    jsonb_typeof("partialSources") = 'array'
    AND (
      ("status" = 'partial' AND jsonb_array_length("partialSources") >= 3)
      OR (
        "status" = 'succeeded'
        AND "reportType" = 'research_report'
        AND jsonb_array_length("partialSources") >= 1
      )
      OR ("status" = 'succeeded' AND "reportType" = 'summary_brief')
      OR ("status" NOT IN ('partial', 'succeeded'))
    )
  );
