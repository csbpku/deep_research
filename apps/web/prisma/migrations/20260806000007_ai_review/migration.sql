ALTER TABLE "ai_research_jobs"
  ADD COLUMN "reviewStatus" VARCHAR(32),
  ADD COLUMN "reviewAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reviewSummary" JSONB,
  ADD COLUMN "reviewClaims" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "reviewedAt" TIMESTAMPTZ(3),
  ADD COLUMN "reviewDetails" JSONB;

ALTER TABLE "researches"
  ADD COLUMN "reviewStatus" VARCHAR(32),
  ADD COLUMN "reviewAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reviewSummary" JSONB,
  ADD COLUMN "reviewClaims" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "reviewedAt" TIMESTAMPTZ(3),
  ADD COLUMN "reviewDetails" JSONB;
