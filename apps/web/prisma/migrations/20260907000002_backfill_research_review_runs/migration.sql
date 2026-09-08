-- Preserve the last legacy review snapshot as a historical run.  This is a
-- compatibility import, not a new verdict: the original claims/summary are
-- copied verbatim and the run is labelled migration in `triggeredBy`.
INSERT INTO "research_review_runs" (
  "researchId", "aiResearchJobId", "revisionHash", "sourceSnapshotHash",
  "policyVersion", "executionStatus", "outcome", "attempt", "startedAt",
  "completedAt", "summary", "claims", "details", "triggeredBy", "createdAt"
)
SELECT
  r."id",
  j."id",
  -- pgcrypto is not required by the base schema.  Legacy rows use a
  -- deterministic 64-character compatibility fingerprint; newly created
  -- runs use SHA-256 in the application boundary.
  repeat(md5(r."body"), 2),
  repeat(md5(COALESCE((
    SELECT string_agg(
      rs."canonicalKey" || E'\\n' || COALESCE(rs."title", '') || E'\\n' || COALESCE(rs."description", ''),
      E'\\n' ORDER BY rs."canonicalKey"
    )
    FROM "research_sources" rs
    WHERE rs."researchId" = r."id"
  ), '')), 2),
  'fact-review-v1',
  CASE r."reviewStatus"
    WHEN 'review_unavailable' THEN 'unavailable'
    WHEN 'queued' THEN 'queued'
    WHEN 'reviewing' THEN 'reviewing'
    WHEN 'passed' THEN 'completed'
    WHEN 'needs_revision' THEN 'completed'
    WHEN 'blocked' THEN 'completed'
    ELSE 'stale'
  END,
  CASE r."reviewStatus"
    WHEN 'passed' THEN 'clear'
    WHEN 'needs_revision' THEN 'attention'
    WHEN 'blocked' THEN 'blocked'
    WHEN 'review_unavailable' THEN 'unavailable'
    WHEN 'queued' THEN NULL
    WHEN 'reviewing' THEN NULL
    ELSE 'stale'
  END,
  r."reviewAttempts",
  r."reviewStartedAt",
  r."reviewedAt",
  r."reviewSummary",
  r."reviewClaims",
  r."reviewDetails",
  'migration',
  COALESCE(r."reviewedAt", r."createdAt")
FROM "researches" r
LEFT JOIN "ai_research_jobs" j ON j."draftResearchId" = r."id"
WHERE r."creationMethod" = 'ai_research'
  AND NOT EXISTS (
    SELECT 1 FROM "research_review_runs" rr WHERE rr."researchId" = r."id"
  );
