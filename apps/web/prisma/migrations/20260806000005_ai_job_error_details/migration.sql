-- Structured diagnostics for AI job failures. Keep errorMessage concise for users;
-- errorDetails is for Admin/debugging and must never contain prompts or credentials.
ALTER TABLE "ai_research_jobs"
  ADD COLUMN "errorDetails" JSONB;
