ALTER TABLE "comments" ADD COLUMN "anchor" JSONB;

CREATE TABLE "research_citations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "researchId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "marker" VARCHAR(64) NOT NULL,
    "quote" VARCHAR(2000) NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "research_citations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "research_citations_researchId_fkey" FOREIGN KEY ("researchId") REFERENCES "researches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "research_citations_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "research_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "research_citations_researchId_marker_key" ON "research_citations"("researchId", "marker");
CREATE INDEX "research_citations_researchId_idx" ON "research_citations"("researchId");
CREATE INDEX "research_citations_sourceId_idx" ON "research_citations"("sourceId");
