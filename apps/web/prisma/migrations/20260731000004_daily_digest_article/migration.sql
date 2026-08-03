-- Radar daily digest article (replaces the old manual 4-item selection flow).
--
-- A digest is still a `summaries` row (so comments reuse the existing
-- summary comment target), distinguished by canonicalUrl `digest://YYYY-MM-DD`.
-- digestMeta stores the structured article produced by
-- ai_engine/radar/daily_digest.py: tldr, narrative sections, highlights,
-- ranked items (with summaryId -> /radar/{id} links), sources and model info.

ALTER TABLE "summaries"
  ADD COLUMN "digestMeta" JSONB;

CREATE INDEX "summaries_digest_date_idx"
  ON "summaries" ("summaryDate" DESC, "publishedAt" DESC)
  WHERE "canonicalUrl" LIKE 'digest://%';
