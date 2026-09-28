-- Browser-reading rows use the source URL/Reader path instead of a cached
-- server-side source snapshot. Missing enrichment is intentional for these
-- rows and must not demote their independently scored discovery tier.

CREATE OR REPLACE FUNCTION radar_queue_summary_enrichment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_tier text;
  source_changed boolean;
  contract_ready boolean;
  external_reading boolean;
BEGIN
  IF NEW."distilledTargetTier" IS NULL
    AND NEW."distilledTier" IN ('collection', 'deep_read')
  THEN
    NEW."distilledTargetTier" := NEW."distilledTier";
  END IF;

  target_tier := COALESCE(NEW."distilledTargetTier", NEW."distilledTier");
  external_reading := 'external_reading' = ANY(COALESCE(NEW."tags", ARRAY[]::text[]));
  source_changed := false;
  IF TG_OP = 'UPDATE' THEN
    source_changed := OLD."originalSha256" IS DISTINCT FROM NEW."originalSha256"
      OR OLD."originalMeta" IS DISTINCT FROM NEW."originalMeta"
      OR OLD."originalMarkdown" IS DISTINCT FROM NEW."originalMarkdown"
      OR OLD."originalFetchedAt" IS DISTINCT FROM NEW."originalFetchedAt";
  END IF;
  contract_ready := radar_enrichment_contract_ready(
    NEW."originalKind",
    NEW."originalMeta",
    NEW."enrichmentStatus",
    NEW."readerQualityStatus"
  );

  IF target_tier IN ('collection', 'deep_read') AND external_reading THEN
    NEW."distilledTier" := target_tier;
    NEW."tags" := ARRAY(
      SELECT tag FROM unnest(COALESCE(NEW."tags", ARRAY[]::text[])) AS tag
      WHERE tag NOT LIKE 'tier_%'
    );
    NEW."tags" := array_append(NEW."tags", 'tier_' || target_tier);
    IF NEW."enrichmentStatus" IN ('pending', 'retryable') THEN
      NEW."enrichmentStatus" := NULL;
      NEW."enrichmentNextRetryAt" := NULL;
    END IF;
  ELSIF target_tier IN ('collection', 'deep_read') AND source_changed
    AND NEW."enrichmentStatus" = 'ready'
  THEN
    contract_ready := false;
    NEW."enrichmentStatus" := 'pending';
    NEW."enrichmentNextRetryAt" := CURRENT_TIMESTAMP;
  END IF;

  IF target_tier IN ('collection', 'deep_read') AND NOT external_reading
    AND NOT contract_ready
  THEN
    NEW."distilledTier" := 'skim';
    NEW."tags" := ARRAY(
      SELECT tag FROM unnest(COALESCE(NEW."tags", ARRAY[]::text[])) AS tag
      WHERE tag NOT LIKE 'tier_%'
    );
    NEW."tags" := array_append(NEW."tags", 'tier_skim');
    IF NEW."enrichmentStatus" IS NULL
      OR (NEW."enrichmentStatus" = 'ready' AND source_changed)
    THEN
      NEW."enrichmentStatus" := 'pending';
      NEW."enrichmentNextRetryAt" := CURRENT_TIMESTAMP;
    ELSIF NEW."enrichmentStatus" = 'ready' THEN
      NEW."enrichmentStatus" := 'retryable';
      NEW."enrichmentNextRetryAt" := CURRENT_TIMESTAMP;
    END IF;
  ELSIF target_tier IN ('collection', 'deep_read') AND NOT external_reading
    AND contract_ready
  THEN
    NEW."distilledTier" := target_tier;
    NEW."tags" := ARRAY(
      SELECT tag FROM unnest(COALESCE(NEW."tags", ARRAY[]::text[])) AS tag
      WHERE tag NOT LIKE 'tier_%'
    );
    NEW."tags" := array_append(NEW."tags", 'tier_' || target_tier);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS radar_queue_summary_enrichment ON "summaries";
CREATE TRIGGER radar_queue_summary_enrichment
  BEFORE INSERT OR UPDATE OF
    "distilledTier", "distilledTargetTier", "originalSha256", "originalMeta",
    "originalMarkdown", "originalFetchedAt", "enrichmentStatus", "readerQualityStatus", "tags"
  ON "summaries"
  FOR EACH ROW
  EXECUTE FUNCTION radar_queue_summary_enrichment();

-- Restore only explicitly marked browser-reading rows; unresolved rows in the
-- traditional enriched mode continue to be governed by the old contract.
UPDATE "summaries"
SET
  "distilledTier" = "distilledTargetTier",
  "enrichmentStatus" = CASE
    WHEN "enrichmentStatus" IN ('pending', 'retryable') THEN NULL
    ELSE "enrichmentStatus"
  END,
  "enrichmentNextRetryAt" = CASE
    WHEN "enrichmentStatus" IN ('pending', 'retryable') THEN NULL
    ELSE "enrichmentNextRetryAt"
  END,
  "tags" = array_append(
    ARRAY(
      SELECT tag FROM unnest(COALESCE("tags", ARRAY[]::text[])) AS tag
      WHERE tag NOT LIKE 'tier_%'
    ),
    'tier_' || "distilledTargetTier"
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE 'external_reading' = ANY(COALESCE("tags", ARRAY[]::text[]))
  AND "distilledTargetTier" IN ('collection', 'deep_read')
  AND (
    "distilledTier" IS DISTINCT FROM "distilledTargetTier"
    OR "enrichmentStatus" IN ('pending', 'retryable')
  );
