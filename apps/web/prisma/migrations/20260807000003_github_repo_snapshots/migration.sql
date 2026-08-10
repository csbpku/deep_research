ALTER TABLE "radar_tracked_repos"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "stars" INTEGER,
  ADD COLUMN IF NOT EXISTS "forks" INTEGER,
  ADD COLUMN IF NOT EXISTS "openIssues" INTEGER,
  ADD COLUMN IF NOT EXISTS "defaultBranch" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "pushedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "githubUpdatedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "snapshotFetchedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "snapshotSha256" CHAR(64);

CREATE TABLE IF NOT EXISTS "radar_github_activities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerRepo" VARCHAR(200) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "number" VARCHAR(100) NOT NULL,
  "title" VARCHAR(500) NOT NULL,
  "url" VARCHAR(2048) NOT NULL,
  "state" VARCHAR(32),
  "author" VARCHAR(200),
  "updatedAtGithub" TIMESTAMPTZ(3),
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "radar_github_activities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "radar_github_activities_ownerRepo_kind_number_key"
  ON "radar_github_activities"("ownerRepo", "kind", "number");
CREATE INDEX IF NOT EXISTS "radar_github_activities_ownerRepo_updatedAtGithub_idx"
  ON "radar_github_activities"("ownerRepo", "updatedAtGithub" DESC);

CREATE TABLE IF NOT EXISTS "radar_github_signals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerRepo" VARCHAR(200) NOT NULL,
  "runId" UUID NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "radar_github_signals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "radar_github_signals_ownerRepo_runId_key"
  ON "radar_github_signals"("ownerRepo", "runId");
CREATE INDEX IF NOT EXISTS "radar_github_signals_ownerRepo_observedAt_idx"
  ON "radar_github_signals"("ownerRepo", "observedAt" DESC);
