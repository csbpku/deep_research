-- Persist the user/assistant planning conversation alongside each AI research job.
ALTER TABLE "ai_research_jobs"
ADD COLUMN "conversation" JSONB NOT NULL DEFAULT '[]'::jsonb;
