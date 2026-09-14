-- Bound recurring radar failures without deleting source evidence.
ALTER TABLE "radar_sources"
  ADD COLUMN "autoPausedAt" TIMESTAMPTZ(3),
  ADD COLUMN "autoPauseReason" VARCHAR(500);

CREATE INDEX "radar_sources_auto_paused_idx"
  ON "radar_sources" ("autoPausedAt")
  WHERE "autoPausedAt" IS NOT NULL;

-- Topic issue clustering is a derived projection. Persist its input cursor
-- and bounded retry state so one broken LLM/provider cannot be called every
-- five minutes forever.
ALTER TABLE "topics"
  ADD COLUMN "issueLastCandidateAt" TIMESTAMPTZ(3),
  ADD COLUMN "issueLastAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "issueFailureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "issueNextRetryAt" TIMESTAMPTZ(3),
  ADD COLUMN "issueLastErrorCode" VARCHAR(64),
  ADD COLUMN "issueLastErrorMessage" VARCHAR(500);

CREATE INDEX "topics_issue_retry_idx"
  ON "topics" ("issueNextRetryAt", "updatedAt");
