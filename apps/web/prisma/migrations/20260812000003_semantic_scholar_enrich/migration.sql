-- P2.15 Semantic Scholar enrich on radar summaries.
-- Stores the canonical paper id + inbound / outbound / influential citation
-- counts so the admin /radar list can rank by research impact, not just
-- recency. Populated lazily by ai_engine.radar.semantic_scholar.run when
-- a summary carries a clean arxiv id; never required.

ALTER TABLE "summaries"
  ADD COLUMN "semanticScholarId"          VARCHAR(64),
  ADD COLUMN "citationCount"              INTEGER,
  ADD COLUMN "referenceCount"             INTEGER,
  ADD COLUMN "influentialCitationCount"   INTEGER;

CREATE INDEX "summaries_semantic_scholar_id_idx"
  ON "summaries" ("semanticScholarId")
  WHERE "semanticScholarId" IS NOT NULL;

CREATE INDEX "summaries_citation_count_idx"
  ON "summaries" ("citationCount" DESC NULLS LAST)
  WHERE "citationCount" IS NOT NULL;
