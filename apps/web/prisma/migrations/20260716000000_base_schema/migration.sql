-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('member', 'admin');

-- CreateEnum
CREATE TYPE "SummaryStatus" AS ENUM ('candidate', 'pending_review', 'published', 'rejected', 'archived');

-- CreateEnum
CREATE TYPE "SummarySource" AS ENUM ('daily', 'user');

-- CreateEnum
CREATE TYPE "ContentOrigin" AS ENUM ('web', 'rss', 'api', 'manual');

-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "ResearchType" AS ENUM ('research', 'knowledge');

-- CreateEnum
CREATE TYPE "CreationMethod" AS ENUM ('manual', 'ai_research', 'file_import', 'confluence_import');

-- CreateEnum
CREATE TYPE "PromoteStatus" AS ENUM ('none', 'nominated', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AiJobStep" AS ENUM ('plan', 'search', 'compress', 'analyze', 'write');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ImportSourceKind" AS ENUM ('file', 'confluence');

-- CreateEnum
CREATE TYPE "CommentTarget" AS ENUM ('research', 'summary');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "avatarUrl" VARCHAR(2048),
    "role" "UserRole" NOT NULL DEFAULT 'member',
    "disabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "summaries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(300) NOT NULL,
    "body" TEXT NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "canonicalUrl" VARCHAR(2048) NOT NULL,
    "source" "SummarySource" NOT NULL,
    "contentOrigin" "ContentOrigin" NOT NULL DEFAULT 'web',
    "userNote" VARCHAR(500),
    "sharedByUserId" UUID,
    "summaryDate" DATE NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "contentSha256" CHAR(64),
    "status" "SummaryStatus" NOT NULL DEFAULT 'candidate',
    "ingestionTokenCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "researches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "ResearchType" NOT NULL,
    "status" "ResearchStatus" NOT NULL DEFAULT 'draft',
    "title" VARCHAR(300) NOT NULL,
    "body" TEXT NOT NULL,
    "background" VARCHAR(2000),
    "conclusion" VARCHAR(2000),
    "risks" VARCHAR(2000),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorId" UUID NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "aiAssisted" BOOLEAN NOT NULL DEFAULT false,
    "creationMethod" "CreationMethod" NOT NULL DEFAULT 'manual',
    "originContentSha256" CHAR(64),
    "sourceCommentId" UUID,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "starCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "researches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "researchId" UUID NOT NULL,
    "sourceRef" JSONB NOT NULL,
    "canonicalKey" VARCHAR(512) NOT NULL,
    "title" VARCHAR(300),
    "description" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_research_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requesterId" UUID NOT NULL,
    "topic" VARCHAR(200) NOT NULL,
    "context" VARCHAR(2000),
    "reportType" VARCHAR(40) NOT NULL DEFAULT 'research_report',
    "sourcePolicy" VARCHAR(40) NOT NULL DEFAULT 'prefer_user_sources',
    "status" "AiJobStatus" NOT NULL DEFAULT 'queued',
    "currentStep" "AiJobStep",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "partialSources" JSONB NOT NULL DEFAULT '[]',
    "lockedBy" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "heartbeatAt" TIMESTAMPTZ(3),
    "nextRetryAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "tokenInputTotal" INTEGER NOT NULL DEFAULT 0,
    "tokenOutputTotal" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" UUID,
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(500),
    "draftResearchId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_research_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_research_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "jobId" UUID NOT NULL,
    "sourceRef" JSONB NOT NULL,
    "canonicalKey" VARCHAR(512) NOT NULL,
    "title" VARCHAR(300),
    "snippet" VARCHAR(2000),
    "score" DOUBLE PRECISION,
    "stepCaptured" "AiJobStep" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_research_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "authorId" UUID NOT NULL,
    "targetType" "CommentTarget" NOT NULL,
    "researchId" UUID,
    "summaryId" UUID,
    "body" VARCHAR(2000) NOT NULL,
    "parentId" UUID,
    "promoteStatus" "PromoteStatus" NOT NULL DEFAULT 'none',
    "starCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_stars" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "commentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_stars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "researchId" UUID NOT NULL,
    "editorId" UUID NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "diff" JSONB,
    "prevSnapshot" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_import_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requesterId" UUID NOT NULL,
    "sourceKind" "ImportSourceKind" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'queued',
    "originalFilename" VARCHAR(255),
    "mimeType" VARCHAR(127),
    "sizeBytes" BIGINT,
    "contentSha256" CHAR(64),
    "sourceUrl" VARCHAR(2048),
    "externalPageId" VARCHAR(255),
    "externalVersion" VARCHAR(64),
    "tempObjectKey" VARCHAR(255),
    "converterVersion" VARCHAR(64) NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(500),
    "outputResearchId" UUID,
    "lockedBy" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "heartbeatAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "content_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_disabledAt_idx" ON "users"("role", "disabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "summaries_canonicalUrl_key" ON "summaries"("canonicalUrl");

-- CreateIndex
CREATE INDEX "summaries_source_createdAt_idx" ON "summaries"("source", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "summaries_status_createdAt_idx" ON "summaries"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "summaries_summaryDate_idx" ON "summaries"("summaryDate");

-- CreateIndex
CREATE INDEX "summaries_sharedByUserId_idx" ON "summaries"("sharedByUserId");

-- CreateIndex
CREATE INDEX "researches_type_publishedAt_idx" ON "researches"("type", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "researches_authorId_status_idx" ON "researches"("authorId", "status");

-- CreateIndex
CREATE INDEX "researches_aiAssisted_idx" ON "researches"("aiAssisted");

-- CreateIndex
CREATE INDEX "researches_sourceCommentId_idx" ON "researches"("sourceCommentId");

-- CreateIndex
CREATE INDEX "research_sources_researchId_idx" ON "research_sources"("researchId");

-- CreateIndex
CREATE UNIQUE INDEX "research_sources_researchId_canonicalKey_key" ON "research_sources"("researchId", "canonicalKey");

-- CreateIndex
CREATE INDEX "ai_research_jobs_status_createdAt_idx" ON "ai_research_jobs"("status", "createdAt" ASC);

-- CreateIndex
CREATE INDEX "ai_research_jobs_status_leaseExpiresAt_idx" ON "ai_research_jobs"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ai_research_jobs_requesterId_createdAt_idx" ON "ai_research_jobs"("requesterId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ai_research_sources_jobId_idx" ON "ai_research_sources"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_research_sources_jobId_canonicalKey_key" ON "ai_research_sources"("jobId", "canonicalKey");

-- CreateIndex
CREATE INDEX "comments_summaryId_createdAt_idx" ON "comments"("summaryId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "comments_researchId_createdAt_idx" ON "comments"("researchId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "comments_authorId_idx" ON "comments"("authorId");

-- CreateIndex
CREATE INDEX "comments_parentId_idx" ON "comments"("parentId");

-- CreateIndex
CREATE INDEX "comments_promoteStatus_idx" ON "comments"("promoteStatus");

-- CreateIndex
CREATE INDEX "comment_stars_userId_createdAt_idx" ON "comment_stars"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "comment_stars_commentId_userId_key" ON "comment_stars"("commentId", "userId");

-- CreateIndex
CREATE INDEX "research_audit_researchId_createdAt_idx" ON "research_audit"("researchId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "content_import_jobs_status_createdAt_idx" ON "content_import_jobs"("status", "createdAt" ASC);

-- CreateIndex
CREATE INDEX "content_import_jobs_requesterId_createdAt_idx" ON "content_import_jobs"("requesterId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_sharedByUserId_fkey" FOREIGN KEY ("sharedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "researches" ADD CONSTRAINT "researches_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "researches" ADD CONSTRAINT "researches_sourceCommentId_fkey" FOREIGN KEY ("sourceCommentId") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_researchId_fkey" FOREIGN KEY ("researchId") REFERENCES "researches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_research_jobs" ADD CONSTRAINT "ai_research_jobs_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_research_sources" ADD CONSTRAINT "ai_research_sources_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ai_research_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "summaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_researchId_fkey" FOREIGN KEY ("researchId") REFERENCES "researches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_stars" ADD CONSTRAINT "comment_stars_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_stars" ADD CONSTRAINT "comment_stars_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_audit" ADD CONSTRAINT "research_audit_researchId_fkey" FOREIGN KEY ("researchId") REFERENCES "researches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_audit" ADD CONSTRAINT "research_audit_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_import_jobs" ADD CONSTRAINT "content_import_jobs_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
