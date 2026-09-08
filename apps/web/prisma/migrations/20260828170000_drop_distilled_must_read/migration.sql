-- Drop the unused distilledMustRead column and its composite index.
-- must_read was never set true in production; tiers stay untouched.
DROP INDEX IF EXISTS "summaries_distilledMustRead_distilledTotal_createdAt_idx";

ALTER TABLE "summaries" DROP COLUMN IF EXISTS "distilledMustRead";
