ALTER TABLE "ai_research_jobs"
  ADD COLUMN "artifactType" VARCHAR(24) NOT NULL DEFAULT 'markdown';

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
      "status" <> 'succeeded'
      AND "draftResearchId" IS NULL
      AND "outputText" IS NULL
    )
  );

ALTER TABLE "ai_research_jobs"
  ADD CONSTRAINT "ai_jobs_partial_sources_valid"
  CHECK (
    jsonb_typeof("partialSources") = 'array'
    AND (
      ("status" = 'partial' AND jsonb_array_length("partialSources") >= 3)
      OR (
        "status" = 'succeeded'
        AND "reportType" IN ('research_report', 'slides')
        AND jsonb_array_length("partialSources") >= 1
      )
      OR ("status" = 'succeeded' AND "reportType" = 'summary_brief')
      OR ("status" NOT IN ('partial', 'succeeded'))
    )
  );
