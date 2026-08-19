-- 技术认知闭环 V2（ADR 0010）
-- 新增 TopicIssue / TopicIssueCandidate / ResearchTopic
-- 扩展 Topic / TopicFollow / AiResearchJob
-- 不破坏现有数据；现有字段与索引保持兼容。

DO $$ BEGIN
  CREATE TYPE "TopicIssueKind" AS ENUM ('event', 'problem');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TopicIssueStatus" AS ENUM ('active', 'resolved', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchTopicRelation" AS ENUM ('auto', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "topics"
  ADD COLUMN IF NOT EXISTS "previousCandidateCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "topics"
  ADD COLUMN IF NOT EXISTS "synthesisInputHash" VARCHAR(64);

UPDATE "topics"
   SET "synthesisVersion" = 'v2'
 WHERE "synthesisVersion" IS NULL;

ALTER TABLE "topic_follows"
  ADD COLUMN IF NOT EXISTS "lastViewedAt" TIMESTAMPTZ(3);

ALTER TABLE "ai_research_jobs"
  ADD COLUMN IF NOT EXISTS "objective" VARCHAR(20) NOT NULL DEFAULT 'investigate',
  ADD COLUMN IF NOT EXISTS "brief" JSONB,
  ADD COLUMN IF NOT EXISTS "plan" JSONB,
  ADD COLUMN IF NOT EXISTS "primaryTopicId" UUID;

CREATE TABLE IF NOT EXISTS "topic_issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "topicId" UUID NOT NULL,
    "kind" "TopicIssueKind" NOT NULL,
    "status" "TopicIssueStatus" NOT NULL DEFAULT 'active',
    "title" VARCHAR(200) NOT NULL,
    "proposition" VARCHAR(1000) NOT NULL,
    "summary" VARCHAR(2000),
    "importanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synthesisPayload" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_issues_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "topic_issues_topicId_fkey"
      FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "topic_issues_topicId_status_lastSeenAt_idx"
    ON "topic_issues"("topicId", "status", "lastSeenAt" DESC);
CREATE INDEX IF NOT EXISTS "topic_issues_topicId_importanceScore_idx"
    ON "topic_issues"("topicId", "importanceScore" DESC);

CREATE TABLE IF NOT EXISTS "topic_issue_candidates" (
    "issueId" UUID NOT NULL,
    "summaryId" UUID NOT NULL,
    "relevanceScore" DOUBLE PRECISION,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_issue_candidates_pkey" PRIMARY KEY ("issueId", "summaryId"),
    CONSTRAINT "topic_issue_candidates_issueId_fkey"
      FOREIGN KEY ("issueId") REFERENCES "topic_issues"("id") ON DELETE CASCADE,
    CONSTRAINT "topic_issue_candidates_summaryId_fkey"
      FOREIGN KEY ("summaryId") REFERENCES "summaries"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "topic_issue_candidates_summaryId_idx"
    ON "topic_issue_candidates"("summaryId");

CREATE TABLE IF NOT EXISTS "research_topics" (
    "researchId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "relationType" "ResearchTopicRelation" NOT NULL DEFAULT 'auto',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_topics_pkey" PRIMARY KEY ("researchId", "topicId"),
    CONSTRAINT "research_topics_researchId_fkey"
      FOREIGN KEY ("researchId") REFERENCES "researches"("id") ON DELETE CASCADE,
    CONSTRAINT "research_topics_topicId_fkey"
      FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "research_topics_topicId_createdAt_idx"
    ON "research_topics"("topicId", "createdAt" DESC);

DO $$ BEGIN
  ALTER TABLE "ai_research_jobs"
    ADD CONSTRAINT "ai_research_jobs_primaryTopicId_fkey"
    FOREIGN KEY ("primaryTopicId") REFERENCES "topics"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ai_research_jobs_primaryTopicId_createdAt_idx"
    ON "ai_research_jobs"("primaryTopicId", "createdAt" DESC);
