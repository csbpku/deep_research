-- Admin-reviewed topic proposals. Proposed clusters never appear on /topics.
CREATE TYPE "TopicProposalStatus" AS ENUM ('proposed', 'approved', 'rejected', 'expired');
CREATE TYPE "TopicProposalKind" AS ENUM ('event', 'problem');

CREATE TABLE "topic_proposals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "proposalKey" VARCHAR(64) NOT NULL UNIQUE,
  "name" VARCHAR(200) NOT NULL,
  "proposition" VARCHAR(1000) NOT NULL,
  "kind" "TopicProposalKind" NOT NULL,
  "status" "TopicProposalStatus" NOT NULL DEFAULT 'proposed',
  "confidence" DOUBLE PRECISION,
  "candidateCount" INT NOT NULL DEFAULT 0,
  "sourceCount" INT NOT NULL DEFAULT 0,
  "windowStart" TIMESTAMPTZ(3) NOT NULL,
  "windowEnd" TIMESTAMPTZ(3) NOT NULL,
  "algorithmVersion" VARCHAR(32) NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "publishedTopicId" UUID UNIQUE,
  "reviewerId" UUID,
  "reviewReason" VARCHAR(500),
  "reviewedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "topic_proposals_published_topic_fk"
    FOREIGN KEY ("publishedTopicId") REFERENCES "topics"("id") ON DELETE SET NULL,
  CONSTRAINT "topic_proposals_reviewer_fk"
    FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "topic_proposals_status_created_idx"
  ON "topic_proposals" ("status", "createdAt" DESC);
CREATE INDEX "topic_proposals_window_idx"
  ON "topic_proposals" ("windowEnd" DESC);

CREATE TABLE "topic_proposal_candidates" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "proposalId" UUID NOT NULL REFERENCES "topic_proposals"("id") ON DELETE CASCADE,
  "summaryId" UUID NOT NULL REFERENCES "summaries"("id") ON DELETE CASCADE,
  "fitScore" DOUBLE PRECISION,
  "evidence" VARCHAR(500),
  "included" BOOLEAN NOT NULL DEFAULT true,
  "exclusionReason" VARCHAR(300),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE ("proposalId", "summaryId")
);

CREATE INDEX "topic_proposal_candidates_summary_idx"
  ON "topic_proposal_candidates" ("summaryId");
