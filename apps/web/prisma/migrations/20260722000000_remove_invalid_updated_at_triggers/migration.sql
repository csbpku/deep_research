-- These tables intentionally have no updatedAt column. The generic trigger
-- installed by init_constraints makes every UPDATE fail at runtime.
DROP TRIGGER IF EXISTS research_sources_touch_updated_at ON "research_sources";
DROP TRIGGER IF EXISTS ai_research_sources_touch_updated_at ON "ai_research_sources";
DROP TRIGGER IF EXISTS comment_stars_touch_updated_at ON "comment_stars";
DROP TRIGGER IF EXISTS content_import_jobs_touch_updated_at ON "content_import_jobs";
