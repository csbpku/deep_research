ALTER TABLE "researches" ADD COLUMN "featuredAt" TIMESTAMPTZ(3);

CREATE INDEX "researches_featuredAt_idx" ON "researches"("featuredAt");
