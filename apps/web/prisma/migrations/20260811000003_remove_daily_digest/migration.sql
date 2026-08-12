-- Remove the daily digest product model and all digest-only storage.
--
-- Radar summaries remain in `summaries`; `summaryDate` and
-- `SummarySource.daily` are still used for radar ingestion metadata.

BEGIN;

-- Historical digest bookmarks are no longer addressable after the product
-- removal. Delete only that target type; all other user bookmarks remain.
DELETE FROM "user_bookmarks"
WHERE "targetType" = 'daily_digest';

-- Remove historical digest rows as well. Summary comments, feedbacks and
-- topic links cascade from this delete; ordinary radar summaries remain.
DELETE FROM "user_bookmarks" ub
USING "summaries" s
WHERE ub."targetId" = s."id"
  AND s."canonicalUrl" LIKE 'digest://%';

DELETE FROM "summaries"
WHERE "canonicalUrl" LIKE 'digest://%';

-- PostgreSQL enum values cannot be dropped in place on the supported version,
-- so recreate the enum after removing the obsolete rows.
ALTER TABLE "user_bookmarks"
  ALTER COLUMN "targetType" TYPE TEXT
  USING "targetType"::TEXT;

DROP TYPE "BookmarkTargetType";

CREATE TYPE "BookmarkTargetType" AS ENUM (
  'radar_candidate',
  'summary',
  'research',
  'knowledge'
);

ALTER TABLE "user_bookmarks"
  ALTER COLUMN "targetType" TYPE "BookmarkTargetType"
  USING "targetType"::"BookmarkTargetType";

DROP INDEX IF EXISTS "summaries_digest_date_idx";
ALTER TABLE "summaries" DROP COLUMN IF EXISTS "digestMeta";

COMMIT;
