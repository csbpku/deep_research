-- Phase 0 — Radar Deep-Dive data foundation
-- Adds nullable columns to summaries for capturing original source content during
-- radar sync. Used by Phase 1 (chat reads original), Phase 2 (per-source-type
-- structured views), Phase 3 (inline annotation).
--
-- All columns are nullable — existing rows are unaffected. RADAR_DEEPDIVE_ENABLED
-- env flag (default true) gates whether the sync worker populates them.

ALTER TABLE "summaries"
  ADD COLUMN "originalMarkdown"  TEXT,
  ADD COLUMN "originalKind"      VARCHAR(24),
  ADD COLUMN "originalFetchedAt" TIMESTAMPTZ(3),
  ADD COLUMN "originalBytes"     INTEGER,
  ADD COLUMN "originalSha256"    CHAR(64);

-- Optional: index on originalKind for the enrichment worker to query
-- candidates by source type efficiently.
CREATE INDEX "summaries_originalKind_idx"
  ON "summaries" ("originalKind")
  WHERE "originalKind" IS NOT NULL;

-- originalSha256 enables dedup-staleness checks; index is not strictly needed
-- at P0 traffic but is cheap to add now.
CREATE INDEX "summaries_originalSha256_idx"
  ON "summaries" ("originalSha256")
  WHERE "originalSha256" IS NOT NULL;