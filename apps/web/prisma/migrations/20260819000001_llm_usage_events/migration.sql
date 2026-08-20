CREATE TABLE "llm_usage_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operation" VARCHAR(120) NOT NULL,
    "requestId" VARCHAR(128),
    "provider" VARCHAR(32) NOT NULL,
    "requestedModel" VARCHAR(160) NOT NULL,
    "actualModel" VARCHAR(160),
    "fallbackModel" VARCHAR(160),
    "usedFallback" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(16) NOT NULL,
    "errorKind" VARCHAR(64),
    "errorMessage" VARCHAR(500),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costCents" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_usage_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "llm_usage_events_createdAt_idx"
    ON "llm_usage_events"("createdAt" DESC);
CREATE INDEX "llm_usage_events_operation_createdAt_idx"
    ON "llm_usage_events"("operation", "createdAt" DESC);
CREATE INDEX "llm_usage_events_requestedModel_createdAt_idx"
    ON "llm_usage_events"("requestedModel", "createdAt" DESC);
