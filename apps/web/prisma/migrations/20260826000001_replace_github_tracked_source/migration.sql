-- Replace every legacy GitHub activity/digest source with a curated repository
-- source. Historical activity, signal, and repo snapshot tables remain intact
-- for auditability; the runtime no longer reads or writes them.
UPDATE "radar_sources"
SET
  "sourceType" = 'github',
  "config" = jsonb_build_object(
    'mode', 'repos',
    'type', 'repos',
    'pollingIntervalMinutes', 720,
    'repos', COALESCE("config"->'repos', "config"->'trackedRepos', '[]'::jsonb)
  ),
  "updatedAt" = now()
WHERE "sourceType" = 'github_tracked';
