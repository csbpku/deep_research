-- The source is now a normal GitHub repository snapshot source. Remove the
-- legacy "tracked" product wording while retaining the same stable source id.
UPDATE "radar_sources"
SET "name" = 'GitHub Curated Repositories',
    "updatedAt" = now()
WHERE "id" = 'a0000000-0000-0000-0000-000000000005'
  AND "sourceType" = 'github';
