-- P1-D: 热点主题 V1 (ADR 0009)

CREATE TYPE "TopicTier" AS ENUM ('hot', 'warming', 'emerging');

CREATE TYPE "TopicCandidateReason" AS ENUM ('auto', 'admin_manual');

CREATE TABLE "topics" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" VARCHAR(120) NOT NULL UNIQUE,            -- url-safe, lowercase, hyphenated
  "name" VARCHAR(200) NOT NULL,
  "summary" VARCHAR(2000),                          -- AI 综述一句话
  "tier" "TopicTier" NOT NULL DEFAULT 'emerging',
  "candidateCount" INT NOT NULL DEFAULT 0,
  "sourceCount" INT NOT NULL DEFAULT 0,
  "aggregationWindowStart" TIMESTAMPTZ(3) NOT NULL,
  "aggregationWindowEnd" TIMESTAMPTZ(3) NOT NULL,
  "lastSyncedAt" TIMESTAMPTZ(3),
  "synthesisGeneratedAt" TIMESTAMPTZ(3),
  "synthesisModel" VARCHAR(64),
  "synthesisVersion" VARCHAR(16),
  "synthesisPayload" JSONB,                        -- {tldr, sections, references}
  "synthesisErrorCode" VARCHAR(64),
  "synthesisErrorMessage" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX "topics_tier_candidate_idx"
  ON "topics" ("tier", "candidateCount" DESC, "updatedAt" DESC);

CREATE INDEX "topics_window_idx"
  ON "topics" ("aggregationWindowEnd" DESC);

CREATE TABLE "topic_candidates" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "topicId" UUID NOT NULL REFERENCES "topics"("id") ON DELETE CASCADE,
  "summaryId" UUID NOT NULL REFERENCES "summaries"("id") ON DELETE CASCADE,
  "similarityScore" DOUBLE PRECISION,
  "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "addedReason" "TopicCandidateReason" NOT NULL DEFAULT 'auto',
  UNIQUE ("topicId", "summaryId")
);

CREATE INDEX "topic_candidates_summary_idx"
  ON "topic_candidates" ("summaryId");

CREATE TABLE "topic_follows" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "topicId" UUID NOT NULL REFERENCES "topics"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE ("userId", "topicId")
);

CREATE INDEX "topic_follows_topic_idx"
  ON "topic_follows" ("topicId", "createdAt" DESC);
