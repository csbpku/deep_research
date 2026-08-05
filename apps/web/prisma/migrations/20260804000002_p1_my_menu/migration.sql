-- P1-C: "我的"菜单 (ADR 0008)

-- 1. users.preferences (JsonB)
ALTER TABLE "users"
  ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2. user_bookmarks (统一收藏)
CREATE TYPE "BookmarkTargetType" AS ENUM (
  'radar_candidate', 'summary', 'research', 'knowledge', 'daily_digest'
);

CREATE TABLE "user_bookmarks" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "targetType" "BookmarkTargetType" NOT NULL,
  "targetId" UUID NOT NULL,
  "note" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE ("userId", "targetType", "targetId")
);

CREATE INDEX "user_bookmarks_user_created_idx"
  ON "user_bookmarks" ("userId", "createdAt" DESC);

-- 3. research_templates (调研模板)
CREATE TABLE "research_templates" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title" VARCHAR(200) NOT NULL,
  "topic" VARCHAR(200) NOT NULL,
  "background" VARCHAR(2000),
  "reportType" VARCHAR(40) NOT NULL DEFAULT 'research_report',
  "sourcePolicy" VARCHAR(40) NOT NULL DEFAULT 'prefer_user_sources',
  "tags" TEXT[] NOT NULL DEFAULT '{}',
  "useCount" INT NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX "research_templates_owner_idx"
  ON "research_templates" ("ownerId", "updatedAt" DESC);
