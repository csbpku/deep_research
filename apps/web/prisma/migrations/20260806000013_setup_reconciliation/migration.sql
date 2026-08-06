-- Reconcile runtime objects that were added to the schema after the last
-- generated migration. `prisma migrate deploy` on a fresh clone would
-- otherwise create a database that is missing objects the app and ai-engine
-- query (tracked repos, summary highlights, radar_submissions indexes).
--
-- Every statement is idempotent so the migration also applies cleanly to an
-- existing runtime database that already has some of these objects.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'RadarTrackedRepoStatus'
      AND typnamespace = 'public'::regnamespace
      AND typtype = 'e'
  ) THEN
    CREATE TYPE "RadarTrackedRepoStatus" AS ENUM ('tracking', 'pinned', 'archived');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "radar_tracked_repos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerRepo" VARCHAR(200) NOT NULL,
    "status" "RadarTrackedRepoStatus" NOT NULL DEFAULT 'tracking',
    "signalCount7d" INTEGER NOT NULL DEFAULT 0,
    "lastSignalAt" TIMESTAMPTZ(3),
    "lastActivityAt" TIMESTAMPTZ(3),
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "radar_tracked_repos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "radar_tracked_repos_ownerRepo_key"
  ON "radar_tracked_repos"("ownerRepo" ASC);

CREATE INDEX IF NOT EXISTS "radar_tracked_repos_status_lastActivityAt_idx"
  ON "radar_tracked_repos"("status" ASC, "lastActivityAt" DESC);

CREATE INDEX IF NOT EXISTS "radar_tracked_repos_status_signalCount7d_idx"
  ON "radar_tracked_repos"("status" ASC, "signalCount7d" DESC);

CREATE OR REPLACE FUNCTION touch_radar_tracked_repo_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW."updatedAt" = now();
    RETURN NEW;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'radar_tracked_repos_touch_updated_at'
      AND tgrelid = 'radar_tracked_repos'::regclass
  ) THEN
    CREATE TRIGGER radar_tracked_repos_touch_updated_at
    BEFORE UPDATE ON "radar_tracked_repos"
    FOR EACH ROW EXECUTE FUNCTION touch_radar_tracked_repo_updated_at();
  END IF;
END
$$;

ALTER TABLE "summaries" ADD COLUMN IF NOT EXISTS "highlights" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "radar_submissions_summaryId_key"
  ON "radar_submissions"("summaryId");

CREATE INDEX IF NOT EXISTS "radar_submissions_canonicalUrl_idx"
  ON "radar_submissions"("canonicalUrl");

CREATE INDEX IF NOT EXISTS "radar_submissions_contentSha256_idx"
  ON "radar_submissions"("contentSha256");
