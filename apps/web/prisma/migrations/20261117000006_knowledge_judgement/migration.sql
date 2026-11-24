ALTER TABLE "researches"
  ADD COLUMN "judgement" VARCHAR(500),
  ADD COLUMN "judgementConfidence" VARCHAR(16),
  ADD COLUMN "judgementScope" VARCHAR(500),
  ADD COLUMN "judgementReviewAt" TIMESTAMPTZ(3);
