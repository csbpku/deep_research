CREATE TABLE "llm_token_budget_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID,
  "operation" VARCHAR(120) NOT NULL,
  "reservedTokens" BIGINT NOT NULL,
  "actualTokens" BIGINT,
  "status" VARCHAR(16) NOT NULL DEFAULT 'reserved',
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMPTZ(3),
  CONSTRAINT "llm_token_budget_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "llm_token_budget_events_status_check"
    CHECK ("status" IN ('reserved', 'settled', 'released')),
  CONSTRAINT "llm_token_budget_events_reserved_tokens_check"
    CHECK ("reservedTokens" > 0),
  CONSTRAINT "llm_token_budget_events_actual_tokens_check"
    CHECK ("actualTokens" IS NULL OR "actualTokens" >= 0),
  CONSTRAINT "llm_token_budget_events_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "llm_token_budget_events_user_created_idx"
  ON "llm_token_budget_events"("userId", "createdAt" DESC);
CREATE INDEX "llm_token_budget_events_created_status_expiry_idx"
  ON "llm_token_budget_events"("createdAt" DESC, "status", "expiresAt");
