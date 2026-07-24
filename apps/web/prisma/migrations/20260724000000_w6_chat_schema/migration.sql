-- Week 6 [db]：AI 多轮追问 schema（架构 §六点一）
--
-- 表：
--   ai_chat_sessions  —— 会话（绑定用户 + 种子摘要快照）
--   ai_chat_messages  —— 会话消息（user / assistant）
--
-- schema 必须与 docs/contracts/api-schemas.md §"Week 6 Chat API 契约" 一字不差。
-- 索引按契约：
--   ai_chat_sessions_userId_updatedAt_idx  — 用户维度按 updatedAt DESC 查找
--   ai_chat_sessions_status_updatedAt_idx  — 按状态扫描活跃会话
--   ai_chat_messages_sessionId_createdAt_idx — 单会话按时间升序回放
--
-- P0 不在迁移里加 partial unique / CHECK；用户可任意创建会话。

-- CreateEnum
CREATE TYPE "AiChatSessionStatus" AS ENUM ('active', 'closed');

-- CreateEnum
CREATE TYPE "AiChatRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "ai_chat_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "seedSummaryId" UUID,
    "seedSnapshot" JSONB NOT NULL DEFAULT '{}',
    "status" "AiChatSessionStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chat_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL,
    "role" "AiChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "sourcesJson" JSONB,
    "latencyMs" INTEGER,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costCents" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_chat_sessions_userId_updatedAt_idx" ON "ai_chat_sessions"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "ai_chat_sessions_status_updatedAt_idx" ON "ai_chat_sessions"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_chat_messages_sessionId_createdAt_idx" ON "ai_chat_messages"("sessionId", "createdAt" ASC);

-- AddForeignKey
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ai_chat_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ai_chat_sessions_seedSummaryId_fkey" FOREIGN KEY ("seedSummaryId") REFERENCES "summaries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;