-- Persistent ChatGPT-style conversations for AI research.
-- One conversation may exist before its research job is created; the
-- job link is filled in when the research is submitted.
CREATE TABLE "ai_research_conversations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "jobId" UUID,
  "title" VARCHAR(200) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ai_research_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_research_conversation_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL,
  "role" VARCHAR(16) NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_research_conversation_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_research_conversations_jobId_key"
  ON "ai_research_conversations"("jobId");
CREATE INDEX "ai_research_conversations_userId_updatedAt_idx"
  ON "ai_research_conversations"("userId", "updatedAt" DESC);
CREATE INDEX "ai_research_conversation_messages_conversationId_createdAt_idx"
  ON "ai_research_conversation_messages"("conversationId", "createdAt" ASC);

ALTER TABLE "ai_research_conversations"
  ADD CONSTRAINT "ai_research_conversations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_research_conversations"
  ADD CONSTRAINT "ai_research_conversations_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "ai_research_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_research_conversation_messages"
  ADD CONSTRAINT "ai_research_conversation_messages_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ai_research_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
