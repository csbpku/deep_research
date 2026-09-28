ALTER TABLE "researches"
  ADD COLUMN "knowledgeIndexText" TEXT;

CREATE TABLE "personal_knowledge_index_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerId" UUID NOT NULL,
  "researchId" UUID NOT NULL,
  "operation" VARCHAR(16) NOT NULL DEFAULT 'upsert',
  "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMPTZ(3),
  "lockedBy" VARCHAR(128),
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "workspaceSlug" VARCHAR(128),
  "documentPath" TEXT,
  "contentHash" CHAR(64),
  "lastError" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "personal_knowledge_index_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "personal_knowledge_index_tasks_operation_check"
    CHECK ("operation" IN ('upsert', 'delete')),
  CONSTRAINT "personal_knowledge_index_tasks_status_check"
    CHECK ("status" IN ('queued', 'processing', 'completed', 'failed')),
  CONSTRAINT "personal_knowledge_index_tasks_generation_check"
    CHECK ("generation" > 0)
);

CREATE UNIQUE INDEX "personal_knowledge_index_tasks_researchId_key"
  ON "personal_knowledge_index_tasks"("researchId");
CREATE INDEX "personal_knowledge_index_tasks_claim_idx"
  ON "personal_knowledge_index_tasks"("status", "nextRetryAt", "leaseExpiresAt");
CREATE INDEX "personal_knowledge_index_tasks_ownerId_idx"
  ON "personal_knowledge_index_tasks"("ownerId");
