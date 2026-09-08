-- Make follow-up revisions explainable and reversible.
-- Existing messages/audits remain valid through defaults/nullability.

ALTER TABLE "ai_research_conversation_messages"
  ADD COLUMN "intent" VARCHAR(16) NOT NULL DEFAULT 'answer';

ALTER TABLE "research_audit"
  ADD COLUMN "sourceMessageId" UUID,
  ADD COLUMN "sourceIntent" VARCHAR(16),
  ADD COLUMN "sourceQuestion" TEXT,
  ADD COLUMN "reason" VARCHAR(2000),
  ADD COLUMN "sourceRefs" JSONB;

CREATE INDEX "research_audit_sourceMessageId_idx"
  ON "research_audit"("sourceMessageId");

ALTER TABLE "research_audit"
  ADD CONSTRAINT "research_audit_sourceMessageId_fkey"
  FOREIGN KEY ("sourceMessageId")
  REFERENCES "ai_research_conversation_messages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
