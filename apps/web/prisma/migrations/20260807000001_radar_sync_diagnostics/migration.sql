CREATE TYPE "RadarDiagnosticKind" AS ENUM ('filtered', 'failed');
CREATE TYPE "RadarDiagnosticStatus" AS ENUM ('pending', 'promoted', 'dismissed');

CREATE TABLE "radar_sync_diagnostics" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "runId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "kind" "RadarDiagnosticKind" NOT NULL,
  "status" "RadarDiagnosticStatus" NOT NULL DEFAULT 'pending',
  "title" VARCHAR(300) NOT NULL,
  "url" VARCHAR(2048) NOT NULL,
  "canonicalUrl" VARCHAR(2048) NOT NULL,
  "body" TEXT,
  "originalMarkdown" TEXT,
  "originalKind" VARCHAR(24),
  "contentOrigin" VARCHAR(16),
  "publishedAt" TIMESTAMPTZ(3),
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reasonCode" VARCHAR(64) NOT NULL,
  "reasonMessage" VARCHAR(500),
  "errorType" VARCHAR(128),
  "errorDomain" VARCHAR(255),
  "distilledScore" JSONB,
  "distilledTier" VARCHAR(16),
  "promotedSummaryId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "radar_sync_diagnostics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "radar_sync_diagnostics_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "radar_sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "radar_sync_diagnostics_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "radar_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "radar_sync_diagnostics_kind_status_createdAt_idx"
  ON "radar_sync_diagnostics"("kind", "status", "createdAt" DESC);
CREATE INDEX "radar_sync_diagnostics_sourceId_createdAt_idx"
  ON "radar_sync_diagnostics"("sourceId", "createdAt" DESC);
CREATE INDEX "radar_sync_diagnostics_runId_kind_idx"
  ON "radar_sync_diagnostics"("runId", "kind");
