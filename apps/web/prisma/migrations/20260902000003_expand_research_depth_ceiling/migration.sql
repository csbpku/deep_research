-- Deep research now allows the product's 48-source evidence ceiling.
ALTER TABLE "ai_research_jobs"
  DROP CONSTRAINT IF EXISTS "ai_research_jobs_maxUrlsToScrape_check";

ALTER TABLE "ai_research_jobs"
  ADD CONSTRAINT "ai_research_jobs_maxUrlsToScrape_check"
  CHECK ("maxUrlsToScrape" IS NULL OR "maxUrlsToScrape" BETWEEN 5 AND 48);
