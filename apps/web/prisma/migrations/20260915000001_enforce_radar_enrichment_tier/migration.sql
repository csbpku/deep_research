-- A scored tier is not automatically a deliverable reading tier.
-- Keep the score-derived target separately and expose only skim until the
-- source enrichment + reader-quality contract is complete.

ALTER TABLE "summaries"
  ADD COLUMN IF NOT EXISTS "distilledTargetTier" VARCHAR(16);

CREATE INDEX IF NOT EXISTS "summaries_distilledTargetTier_idx"
  ON "summaries" ("distilledTargetTier");

CREATE OR REPLACE FUNCTION radar_enrichment_contract_ready(
  p_kind text,
  p_meta jsonb,
  p_status text,
  p_quality text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  zread jsonb;
  page_count integer;
  expected_page_count integer;
BEGIN
  IF p_status IS DISTINCT FROM 'ready'
    OR p_quality IS DISTINCT FROM 'ready'
    OR COALESCE(p_meta->>'enrichmentVersion', '') <> '2.0'
  THEN
    RETURN false;
  END IF;

  IF p_kind IS DISTINCT FROM 'github_repo' THEN
    RETURN true;
  END IF;

  zread := p_meta->'zread';
  IF zread IS NULL
    OR COALESCE(zread->>'provider', '') = 'github-readme-fallback'
    OR COALESCE(zread->>'status', '') <> 'complete'
    OR lower(COALESCE(zread->>'truncated', 'false')) IN ('1', 'true', 'yes', 'on')
    OR lower(COALESCE(zread->>'mixedCommits', 'false')) IN ('1', 'true', 'yes', 'on')
  THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(zread->'pages') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(zread->'pages') = 0 THEN
    RETURN false;
  END IF;

  IF zread ? 'missingPages' THEN
    IF jsonb_typeof(zread->'missingPages') IS DISTINCT FROM 'array' THEN
      RETURN false;
    END IF;
    IF jsonb_array_length(zread->'missingPages') > 0 THEN
      RETURN false;
    END IF;
  END IF;

  IF COALESCE(zread->>'pageCount', '') !~ '^[0-9]+$'
    OR COALESCE(zread->>'expectedPageCount', '') !~ '^[0-9]+$'
  THEN
    RETURN false;
  END IF;

  BEGIN
    page_count := (zread->>'pageCount')::integer;
    expected_page_count := (zread->>'expectedPageCount')::integer;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  RETURN page_count >= expected_page_count;
END;
$$;

CREATE OR REPLACE FUNCTION radar_queue_summary_enrichment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_tier text;
  source_changed boolean;
  contract_ready boolean;
BEGIN
  -- Rows written by older code have no target column yet. Preserve their
  -- scored tier before making the effective tier honest.
  IF NEW."distilledTargetTier" IS NULL
    AND NEW."distilledTier" IN ('collection', 'deep_read')
  THEN
    NEW."distilledTargetTier" := NEW."distilledTier";
  END IF;

  target_tier := COALESCE(NEW."distilledTargetTier", NEW."distilledTier");
  -- An INSERT has no previous snapshot to invalidate. An already complete
  -- row is allowed to enter as ready; an incomplete row is handled by the
  -- contract branch below.
  source_changed := false;
  IF TG_OP = 'UPDATE' THEN
    -- Changing the scored target or the effective presentation tier is not
    -- a source refresh. Only a new source snapshot invalidates reader
    -- quality; otherwise a deterministic repair that sets status=ready must
    -- be allowed to restore a previously demoted row.
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

  IF target_tier IN ('collection', 'deep_read') AND source_changed
    AND NEW."enrichmentStatus" = 'ready'
  THEN
    -- Do not let a direct write claim that a changed source is still ready.
    -- The application normally clears reader quality in the same statement,
    -- but this keeps SQL clients and one-off repair scripts safe too.
    contract_ready := false;
    NEW."enrichmentStatus" := 'pending';
    NEW."enrichmentNextRetryAt" := CURRENT_TIMESTAMP;
  END IF;

  IF target_tier IN ('collection', 'deep_read') AND NOT contract_ready THEN
    -- The effective tier is always honest while enrichment is pending,
    -- including rows that were written with NULL or a high tier by legacy
    -- code.
    NEW."distilledTier" := 'skim';
    NEW."tags" := ARRAY(
      SELECT tag
      FROM unnest(COALESCE(NEW."tags", ARRAY[]::text[])) AS tag
      WHERE tag NOT LIKE 'tier_%'
    );
    IF NOT ('tier_skim' = ANY(COALESCE(NEW."tags", ARRAY[]::text[]))) THEN
      NEW."tags" := array_append(NEW."tags", 'tier_skim');
    END IF;
    IF NEW."enrichmentStatus" IS NULL
      OR (NEW."enrichmentStatus" = 'ready' AND source_changed)
    THEN
      NEW."enrichmentStatus" := 'pending';
      NEW."enrichmentNextRetryAt" := CURRENT_TIMESTAMP;
    ELSIF NEW."enrichmentStatus" = 'ready' THEN
      NEW."enrichmentStatus" := 'retryable';
      NEW."enrichmentNextRetryAt" := CURRENT_TIMESTAMP;
    END IF;
  ELSIF target_tier IN ('collection', 'deep_read') AND contract_ready THEN
    -- A complete repair may only update status/quality. Restore the scored
    -- target even when the incoming effective tier is still skim.
    NEW."distilledTier" := target_tier;
    NEW."tags" := ARRAY(
      SELECT tag
      FROM unnest(COALESCE(NEW."tags", ARRAY[]::text[])) AS tag
      WHERE tag NOT LIKE 'tier_%'
    );
    NEW."tags" := array_append(NEW."tags", 'tier_' || NEW."distilledTier");
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS radar_queue_summary_enrichment ON "summaries";
CREATE TRIGGER radar_queue_summary_enrichment
  BEFORE INSERT OR UPDATE OF
    "distilledTier", "distilledTargetTier", "originalSha256", "originalMeta",
    "originalMarkdown", "originalFetchedAt", "enrichmentStatus", "readerQualityStatus"
  ON "summaries"
  FOR EACH ROW
  EXECUTE FUNCTION radar_queue_summary_enrichment();

-- Capture the old scored tier, then make every historical high-value row obey
-- the same invariant before the new application code starts serving it.
UPDATE "summaries"
SET "distilledTargetTier" = "distilledTier"
WHERE "distilledTier" IN ('collection', 'deep_read')
  AND "distilledTargetTier" IS NULL;

UPDATE "summaries"
SET
  "distilledTier" = 'skim',
  "enrichmentStatus" = CASE
    WHEN "enrichmentStatus" = 'running' THEN 'running'
    WHEN "enrichmentStatus" = 'manual' THEN 'manual'
    ELSE 'retryable'
  END,
  "enrichmentNextRetryAt" = CASE
    WHEN "enrichmentStatus" IN ('running', 'manual') THEN "enrichmentNextRetryAt"
    ELSE CURRENT_TIMESTAMP
  END,
  "tags" = array_append(
    ARRAY(
      SELECT tag
      FROM unnest(COALESCE("tags", ARRAY[]::text[])) AS tag
      WHERE tag NOT LIKE 'tier_%'
    ),
    'tier_skim'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "distilledTargetTier" IN ('collection', 'deep_read')
  AND NOT radar_enrichment_contract_ready(
    "originalKind",
    "originalMeta",
    "enrichmentStatus",
    "readerQualityStatus"
  );

-- Rows that already have a complete, quality-checked snapshot can retain
-- their scored tier; the previous UPDATE only demoted incomplete rows.
UPDATE "summaries"
SET
  "distilledTier" = "distilledTargetTier",
  "enrichmentStatus" = 'ready',
  "enrichmentNextRetryAt" = NULL,
  "tags" = array_append(
    ARRAY(
      SELECT tag
      FROM unnest(COALESCE("tags", ARRAY[]::text[])) AS tag
      WHERE tag NOT LIKE 'tier_%'
    ),
    'tier_' || "distilledTargetTier"
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "distilledTargetTier" IN ('collection', 'deep_read')
  AND radar_enrichment_contract_ready(
    "originalKind",
    "originalMeta",
    "enrichmentStatus",
    "readerQualityStatus"
  );
