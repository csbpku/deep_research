-- CreateEnum
CREATE TYPE "RadarCandidateStatus" AS ENUM ('new', 'interpreted', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "RadarSyncStatus" AS ENUM ('running', 'completed', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "RadarFeedbackType" AS ENUM ('useful', 'inaccurate', 'used', 'favorite', 'suggest_research');

-- DropIndex

-- AlterTable

-- AlterTable
ALTER TABLE "summaries" ADD COLUMN     "interpretation" VARCHAR(2000),
ADD COLUMN     "relevanceScore" DOUBLE PRECISION,
ADD COLUMN     "scoreReason" VARCHAR(500),
ADD COLUMN     "scoreVersion" VARCHAR(16),
ADD COLUMN     "selectionReason" VARCHAR(500),
ADD COLUMN     "sortOrder" INTEGER,
ADD COLUMN     "sourceQualityScore" DOUBLE PRECISION,
ADD COLUMN     "syncRunId" UUID,
ADD COLUMN     "timelinessScore" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "radar_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "sourceType" VARCHAR(32) NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "radar_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radar_sync_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sourceId" UUID NOT NULL,
    "triggeredBy" VARCHAR(32) NOT NULL,
    "status" "RadarSyncStatus" NOT NULL DEFAULT 'running',
    "totalFetched" INTEGER NOT NULL DEFAULT 0,
    "totalNew" INTEGER NOT NULL DEFAULT 0,
    "totalSkipped" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(500),
    "tokenInputTotal" INTEGER NOT NULL DEFAULT 0,
    "tokenOutputTotal" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "elapsedMs" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "heartbeatAt" TIMESTAMPTZ(3),
    "nextRetryAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "radar_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radar_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "summaryId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "feedbackType" "RadarFeedbackType" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "radar_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "radar_sources_sourceType_enabled_idx" ON "radar_sources"("sourceType", "enabled");

-- CreateIndex
CREATE INDEX "radar_sync_runs_sourceId_createdAt_idx" ON "radar_sync_runs"("sourceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "radar_sync_runs_status_createdAt_idx" ON "radar_sync_runs"("status", "createdAt" ASC);

-- CreateIndex
CREATE INDEX "radar_feedback_summaryId_feedbackType_idx" ON "radar_feedback"("summaryId", "feedbackType");

-- CreateIndex
CREATE INDEX "radar_feedback_userId_createdAt_idx" ON "radar_feedback"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "radar_feedback_summaryId_userId_feedbackType_key" ON "radar_feedback"("summaryId", "userId", "feedbackType");

-- AddForeignKey
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "radar_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "radar_sync_runs" ADD CONSTRAINT "radar_sync_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "radar_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "radar_feedback" ADD CONSTRAINT "radar_feedback_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "summaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "radar_feedback" ADD CONSTRAINT "radar_feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

