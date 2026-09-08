-- Preserve a readable research checkpoint when a deep run reaches the worker
-- budget after writing but before fact review / draft publication completes.
-- This is inline output only: partial jobs still must not own a Research draft.

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
      "status" NOT IN ('succeeded', 'partial')
      AND "draftResearchId" IS NULL
      AND "outputText" IS NULL
    )
  );
