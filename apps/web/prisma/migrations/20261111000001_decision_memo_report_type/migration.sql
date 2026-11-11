-- A decision memo is a markdown research artifact derived from a completed
-- report. It owns the same durable draft contract as a research report; only
-- the writing contract differs, so both success checks must accept it.

ALTER TABLE "ai_research_jobs"
  DROP CONSTRAINT "ai_jobs_draft_matches_status";

ALTER TABLE "ai_research_jobs"
  ADD CONSTRAINT "ai_jobs_draft_matches_status"
  CHECK (
    (
      "status" = 'succeeded'
      AND (
        (
          "reportType" IN ('research_report', 'decision_memo', 'web_brief')
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
        AND "reportType" IN ('research_report', 'decision_memo', 'slides', 'web_brief', 'evidence_search')
        AND jsonb_array_length("partialSources") >= 1
      )
      OR ("status" = 'succeeded' AND "reportType" = 'summary_brief')
      OR ("status" NOT IN ('partial', 'succeeded'))
    )
  );
