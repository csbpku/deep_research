-- Persist the user's research-depth choice so queued jobs keep the same
-- contract after a worker restart.
ALTER TABLE "ai_research_jobs"
  ADD COLUMN "reportLength" VARCHAR(16) NOT NULL DEFAULT 'standard',
  ADD COLUMN "maxUrlsToScrape" INTEGER;

ALTER TABLE "ai_research_jobs"
  ADD CONSTRAINT "ai_research_jobs_reportLength_check"
  CHECK ("reportLength" IN ('brief', 'standard', 'deep'));

ALTER TABLE "ai_research_jobs"
  ADD CONSTRAINT "ai_research_jobs_maxUrlsToScrape_check"
  CHECK ("maxUrlsToScrape" IS NULL OR "maxUrlsToScrape" BETWEEN 5 AND 30);
