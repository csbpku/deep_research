-- Keep existing installations aligned with the current official source
-- endpoints. The old URLs either redirect to a subsection or no longer
-- expose the entry structure used by the fetcher.
UPDATE "radar_sources"
SET "config" = jsonb_set(
  COALESCE("config", '{}'::jsonb),
  '{sources}',
  '["https://developers.openai.com/api/docs/changelog"]'::jsonb,
  true
),
"updatedAt" = now()
WHERE "id" = 'a0000000-0000-0000-0000-000000000019'
  AND "sourceType" = 'vendor_changelog'
  AND COALESCE("config"->>'vendor', '') = 'openai';

UPDATE "radar_sources"
SET "config" = jsonb_set(
  COALESCE("config", '{}'::jsonb),
  '{sources}',
  '["https://platform.claude.com/docs/en/release-notes/feed.xml"]'::jsonb,
  true
),
"updatedAt" = now()
WHERE "id" = 'a0000000-0000-0000-0000-000000000020'
  AND "sourceType" = 'vendor_changelog'
  AND COALESCE("config"->>'vendor', '') = 'anthropic';
