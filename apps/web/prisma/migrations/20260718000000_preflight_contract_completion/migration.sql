-- AlterTable
ALTER TABLE "summaries" ADD COLUMN     "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Align the base migration's nullable array with the final Prisma schema.
ALTER TABLE "researches" ALTER COLUMN "tags" SET NOT NULL;

-- AlterTable
ALTER TABLE "ai_research_jobs" ADD COLUMN     "failedSources" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sourceRefs" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "content_import_jobs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextRetryAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "product_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "eventName" VARCHAR(64) NOT NULL,
    "entityType" VARCHAR(32),
    "entityId" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "dedupeKey" VARCHAR(255) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorId" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "targetType" VARCHAR(32) NOT NULL,
    "targetId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_events_dedupeKey_key" ON "product_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "product_events_eventName_occurredAt_idx" ON "product_events"("eventName", "occurredAt");

-- CreateIndex
CREATE INDEX "product_events_userId_occurredAt_idx" ON "product_events"("userId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_actions_requestId_key" ON "admin_actions"("requestId");

-- CreateIndex
CREATE INDEX "admin_actions_actorId_createdAt_idx" ON "admin_actions"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_actions_targetType_targetId_createdAt_idx" ON "admin_actions"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_research_jobs_draftResearchId_key" ON "ai_research_jobs"("draftResearchId");

-- CreateIndex
CREATE UNIQUE INDEX "content_import_jobs_outputResearchId_key" ON "content_import_jobs"("outputResearchId");

-- AddForeignKey
ALTER TABLE "ai_research_jobs" ADD CONSTRAINT "ai_research_jobs_draftResearchId_fkey" FOREIGN KEY ("draftResearchId") REFERENCES "researches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_import_jobs" ADD CONSTRAINT "content_import_jobs_outputResearchId_fkey" FOREIGN KEY ("outputResearchId") REFERENCES "researches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 同一用户同一文件在 active/succeeded 生命周期只允许一个任务；failed 后退出索引，可重新提交。
DROP INDEX IF EXISTS "content_import_user_hash_partial_uniq";
CREATE UNIQUE INDEX "content_import_user_hash_partial_uniq"
    ON "content_import_jobs" ("requesterId", "contentSha256")
    WHERE "sourceKind" = 'file'
      AND "contentSha256" IS NOT NULL
      AND status IN ('queued', 'running', 'succeeded');

-- 状态机硬约束：终态释放租约，partial 不产草稿，成功任务必须有唯一输出。
ALTER TABLE "ai_research_jobs"
    ADD CONSTRAINT "ai_jobs_attempts_range"
        CHECK ("attempts" BETWEEN 0 AND 3),
    ADD CONSTRAINT "ai_jobs_terminal_lease_cleared"
        CHECK (
            "status" NOT IN ('partial', 'succeeded', 'failed', 'cancelled')
            OR ("lockedBy" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL)
        ),
    ADD CONSTRAINT "ai_jobs_draft_matches_status"
        CHECK (
            ("status" = 'succeeded' AND "draftResearchId" IS NOT NULL)
            OR ("status" <> 'succeeded' AND "draftResearchId" IS NULL)
        ),
    ADD CONSTRAINT "ai_jobs_partial_sources_valid"
        CHECK (
            jsonb_typeof("partialSources") = 'array'
            AND (
                ("status" = 'partial' AND jsonb_array_length("partialSources") >= 3)
                OR ("status" = 'succeeded' AND jsonb_array_length("partialSources") >= 1)
                OR ("status" NOT IN ('partial', 'succeeded'))
            )
        );

ALTER TABLE "content_import_jobs"
    ADD CONSTRAINT "content_import_attempts_range"
        CHECK ("attempts" BETWEEN 0 AND 3),
    ADD CONSTRAINT "content_import_terminal_lease_cleared"
        CHECK (
            "status" NOT IN ('succeeded', 'failed', 'cancelled')
            OR ("lockedBy" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL)
        ),
    ADD CONSTRAINT "content_import_output_matches_status"
        CHECK (
            ("status" = 'succeeded' AND "outputResearchId" IS NOT NULL)
            OR ("status" <> 'succeeded' AND "outputResearchId" IS NULL)
        );

ALTER TABLE "researches"
    ADD CONSTRAINT "research_ai_origin_hash_required"
        CHECK (
            ("creationMethod" = 'ai_research' AND "originContentSha256" IS NOT NULL)
            OR ("creationMethod" <> 'ai_research' AND "originContentSha256" IS NULL)
        );
