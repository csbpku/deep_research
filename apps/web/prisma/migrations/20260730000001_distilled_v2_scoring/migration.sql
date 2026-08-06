ALTER TABLE "summaries"
  ADD COLUMN "distilledScore" JSONB,
  ADD COLUMN "distilledTotal" DOUBLE PRECISION,
  ADD COLUMN "distilledTier" VARCHAR(16),
  ADD COLUMN "distilledMustRead" BOOLEAN,
  ADD COLUMN "distilledProfile" VARCHAR(16);

CREATE INDEX "summaries_distilledMustRead_distilledTotal_createdAt_idx"
  ON "summaries" ("distilledMustRead", "distilledTotal" DESC, "createdAt" DESC)
  WHERE "syncRunId" IS NOT NULL;

CREATE INDEX "summaries_distilledProfile_distilledTotal_idx"
  ON "summaries" ("distilledProfile", "distilledTotal" DESC)
  WHERE "syncRunId" IS NOT NULL;
