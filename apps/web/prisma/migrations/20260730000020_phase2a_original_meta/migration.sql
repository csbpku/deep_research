-- Phase 2A — Radar Deep-Dive: originalMeta column for GitHub repo enrichment
--
-- Stores GitHub repo tree + entry points + metadata extracted by the
-- enrichment worker. JSONB keeps the schema flexible (different source
-- types will add their own fields in later phases).

ALTER TABLE "summaries"
  ADD COLUMN "originalMeta" JSONB;

-- Optional partial index — most radar candidates won't have this populated
-- until Phase 2A enrich worker runs.
CREATE INDEX "summaries_originalMeta_present_idx"
  ON "summaries" ("id")
  WHERE "originalMeta" IS NOT NULL;