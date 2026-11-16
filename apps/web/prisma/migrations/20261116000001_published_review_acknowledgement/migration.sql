-- Record what the author acknowledged at publication time.
ALTER TABLE "researches"
  ADD COLUMN "publishedReviewVersion" CHAR(64),
  ADD COLUMN "publishedReviewDisclosure" JSONB,
  ADD COLUMN "publishedReviewAcknowledgedAt" TIMESTAMPTZ(3);
