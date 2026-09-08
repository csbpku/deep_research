-- Keep the durable enrichment queue aligned with the scored radar contract.
--
-- Migration 20260907000007 classified rows that already existed. New rows
-- inserted after that migration were still allowed to leave enrichmentStatus
-- NULL, which made enrichment depend on the worker's legacy compatibility
-- predicate instead of the durable queue.

CREATE OR REPLACE FUNCTION radar_queue_summary_enrichment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."distilledTier" IN ('collection', 'deep_read') THEN
    IF TG_OP = 'INSERT' AND NEW."enrichmentStatus" IS NULL THEN
      NEW."enrichmentStatus" := 'pending';
      NEW."enrichmentNextRetryAt" := COALESCE(
        NEW."enrichmentNextRetryAt",
        CURRENT_TIMESTAMP
      );
    ELSIF TG_OP = 'UPDATE'
      AND (
        OLD."distilledTier" IS DISTINCT FROM NEW."distilledTier"
        OR OLD."originalSha256" IS DISTINCT FROM NEW."originalSha256"
      )
      AND (
        OLD."enrichmentStatus" IS NULL
        OR OLD."enrichmentStatus" = 'ready'
      )
      AND NEW."enrichmentStatus" IS DISTINCT FROM 'running'
    THEN
      -- A fresh source snapshot invalidates the old enrichment result.
      NEW."enrichmentStatus" := 'pending';
      NEW."enrichmentNextRetryAt" := CURRENT_TIMESTAMP;
      NEW."enrichmentLockedBy" := NULL;
      NEW."enrichmentLeaseExpiresAt" := NULL;
      NEW."enrichmentHeartbeatAt" := NULL;
      NEW."enrichmentClaimId" := NULL;
      NEW."enrichmentErrorCode" := NULL;
      NEW."enrichmentErrorMessage" := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS radar_queue_summary_enrichment ON "summaries";
CREATE TRIGGER radar_queue_summary_enrichment
  BEFORE INSERT OR UPDATE OF "distilledTier", "originalSha256", "enrichmentStatus"
  ON "summaries"
  FOR EACH ROW
  EXECUTE FUNCTION radar_queue_summary_enrichment();

-- Repair rows created after the durable-state migration but before this guard.
UPDATE "summaries"
SET
  "enrichmentStatus" = 'pending',
  "enrichmentNextRetryAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "distilledTier" IN ('collection', 'deep_read')
  AND "enrichmentStatus" IS NULL
  AND "originalKind" IN (
    'github_repo',
    'arxiv',
    'github_other',
    'github_issue',
    'github_pr',
    'github_release',
    'rss',
    'web_share'
  );
