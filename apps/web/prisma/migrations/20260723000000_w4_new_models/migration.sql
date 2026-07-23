-- CreateEnum
CREATE TYPE "ShareSubmissionStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "SearchDocType" AS ENUM ('summary', 'long_research', 'knowledge');

-- DropIndex
DROP INDEX "researches_tags_gin";

-- CreateTable
CREATE TABLE "share_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "submitterId" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "canonicalUrl" VARCHAR(2048) NOT NULL,
    "userNote" VARCHAR(500),
    "fetchedTitle" VARCHAR(300),
    "fetchedMarkdown" TEXT,
    "summaryText" VARCHAR(2000),
    "fetchErrorCode" VARCHAR(64),
    "fetchErrorMessage" VARCHAR(500),
    "status" "ShareSubmissionStatus" NOT NULL DEFAULT 'pending',
    "reviewerId" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "publishedSummaryId" UUID,
    "contentSha256" CHAR(64),
    "bytesRead" INTEGER,
    "elapsedMs" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "heartbeatAt" TIMESTAMPTZ(3),
    "nextRetryAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "share_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_docs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "SearchDocType" NOT NULL,
    "refId" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "snippet" VARCHAR(1000) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL,
    "indexedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_docs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "share_submissions_publishedSummaryId_key" ON "share_submissions"("publishedSummaryId");

-- CreateIndex
CREATE INDEX "share_submissions_status_createdAt_idx" ON "share_submissions"("status", "createdAt" ASC);

-- CreateIndex
CREATE INDEX "share_submissions_submitterId_createdAt_idx" ON "share_submissions"("submitterId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "share_submissions_canonicalUrl_idx" ON "share_submissions"("canonicalUrl");

-- CreateIndex
CREATE INDEX "search_docs_type_publishedAt_idx" ON "search_docs"("type", "publishedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "search_docs_type_refId_key" ON "search_docs"("type", "refId");

-- AddForeignKey
ALTER TABLE "share_submissions" ADD CONSTRAINT "share_submissions_submitterId_fkey" FOREIGN KEY ("submitterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_submissions" ADD CONSTRAINT "share_submissions_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_submissions" ADD CONSTRAINT "share_submissions_publishedSummaryId_fkey" FOREIGN KEY ("publishedSummaryId") REFERENCES "summaries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

