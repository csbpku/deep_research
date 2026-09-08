-- web_brief is a grounded markdown artifact, so it must satisfy the same
-- captured-source minimum as research_report and Slides.
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
        AND "reportType" IN ('research_report', 'slides', 'web_brief')
        AND jsonb_array_length("partialSources") >= 1
      )
      OR ("status" = 'succeeded' AND "reportType" = 'summary_brief')
      OR ("status" NOT IN ('partial', 'succeeded'))
    )
  );
