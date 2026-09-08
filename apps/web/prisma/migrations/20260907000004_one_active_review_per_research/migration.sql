-- A draft has one review queue position at a time. Completed, unavailable,
-- and stale runs remain immutable history and are intentionally excluded.
-- First repair any pre-existing duplicate active rows deterministically so
-- this invariant can be introduced safely on an already-used local database.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "researchId"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS position
  FROM "research_review_runs"
  WHERE "executionStatus" IN ('queued', 'reviewing')
)
UPDATE "research_review_runs" AS run
SET
  "executionStatus" = 'stale',
  "outcome" = 'stale',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP)
FROM ranked
WHERE run."id" = ranked."id"
  AND ranked.position > 1;

CREATE UNIQUE INDEX "research_review_runs_one_active_per_research_idx"
  ON "research_review_runs" ("researchId")
  WHERE "executionStatus" IN ('queued', 'reviewing');
