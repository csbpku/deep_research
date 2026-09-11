-- QbitAI is an AI-only editorial feed. The generic mixed-feed keyword gate
-- caused valid stories such as world-model and AI-conference coverage to be
-- discarded before they reached scoring.
UPDATE "radar_sources"
SET "config" = jsonb_set(
  COALESCE("config", '{}'::jsonb),
  '{applyAiFilter}',
  'false'::jsonb,
  true
),
"updatedAt" = now()
WHERE "id" = 'a0000000-0000-0000-0000-000000000022'
  AND "sourceType" = 'rss'
  AND COALESCE("config"->>'feedUrl', '') = 'https://www.qbitai.com/feed'
  AND COALESCE("config"->>'applyAiFilter', 'true') = 'true';
