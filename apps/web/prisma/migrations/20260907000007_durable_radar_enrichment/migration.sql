-- Persist the radar enrichment queue and lease on the summary row itself.
-- A restart must be able to find the row again, reclaim an expired lease,
-- and explain the last failure.
ALTER TABLE "summaries"
  ADD COLUMN "enrichmentStatus" VARCHAR(24),
  ADD COLUMN "enrichmentAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "enrichmentLockedBy" VARCHAR(255),
  ADD COLUMN "enrichmentLeaseExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "enrichmentHeartbeatAt" TIMESTAMPTZ(3),
  ADD COLUMN "enrichmentNextRetryAt" TIMESTAMPTZ(3),
  ADD COLUMN "enrichmentLastAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "enrichmentRequestedAt" TIMESTAMPTZ(3),
  ADD COLUMN "enrichmentRunId" UUID,
  ADD COLUMN "enrichmentErrorCode" VARCHAR(64),
  ADD COLUMN "enrichmentErrorMessage" VARCHAR(500);

CREATE INDEX "summaries_enrichmentStatus_nextRetry_idx"
  ON "summaries" ("enrichmentStatus", "enrichmentNextRetryAt");

CREATE INDEX "summaries_enrichmentLease_idx"
  ON "summaries" ("enrichmentLeaseExpiresAt");

CREATE INDEX "summaries_enrichmentRunId_idx"
  ON "summaries" ("enrichmentRunId");

-- Existing rows are classified from persisted evidence. This is deliberately
-- conservative: a v2 marker with an incomplete reader contract is retryable,
-- not ready. No row is marked approved by this migration.
UPDATE "summaries"
SET
  "enrichmentStatus" = CASE
    WHEN COALESCE("originalMeta"->>'enrichmentVersion', '') <> '2.0'
      THEN 'pending'
    WHEN COALESCE("readerQualityStatus", '') IN ('incomplete', 'invalid')
      THEN 'retryable'
    ELSE 'ready'
  END,
  "enrichmentNextRetryAt" = CASE
    WHEN COALESCE("originalMeta"->>'enrichmentVersion', '') <> '2.0'
      OR COALESCE("readerQualityStatus", '') IN ('incomplete', 'invalid')
      THEN CURRENT_TIMESTAMP
    ELSE NULL
  END
WHERE "distilledTier" IN ('collection', 'deep_read');
