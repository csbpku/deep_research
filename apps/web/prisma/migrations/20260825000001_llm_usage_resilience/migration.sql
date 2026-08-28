ALTER TABLE "llm_usage_events"
    ADD COLUMN "primaryModel" VARCHAR(160),
    ADD COLUMN "fallbackReason" VARCHAR(120),
    ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "finalModel" VARCHAR(160),
    ADD COLUMN "degraded" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "endpoint" VARCHAR(300),
    ADD COLUMN "circuitState" VARCHAR(16);
