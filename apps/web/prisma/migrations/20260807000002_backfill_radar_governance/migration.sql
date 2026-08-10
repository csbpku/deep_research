-- Backfill filtered radar candidates created before per-item diagnostics were enabled.
-- Keep the diagnostic grain at (sync run, canonical URL) so a later promote can
-- still resolve the original summary and its source run.
INSERT INTO "radar_sync_diagnostics" (
  "id", "runId", "sourceId", "kind", "status", "title", "url",
  "canonicalUrl", "body", "originalMarkdown", "originalKind", "contentOrigin",
  "publishedAt", "tags", "reasonCode", "reasonMessage", "distilledScore",
  "distilledTier", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  s."syncRunId",
  r."sourceId",
  'filtered'::"RadarDiagnosticKind",
  'pending'::"RadarDiagnosticStatus",
  s."title",
  s."url",
  s."canonicalUrl",
  s."body",
  s."originalMarkdown",
  s."originalKind",
  s."contentOrigin"::text,
  s."publishedAt",
  s."tags",
  CASE WHEN s."distilledTier" = 'noise' THEN 'DISTILLED_NOISE' ELSE 'PENDING_SCORE' END,
  CASE WHEN s."distilledTier" = 'noise'
    THEN COALESCE(s."scoreReason", '评分判定为不推荐')
    ELSE '评分未完成，已保留在数据库等待治理'
  END,
  s."distilledScore",
  s."distilledTier",
  s."createdAt",
  s."updatedAt"
FROM "summaries" s
JOIN "radar_sync_runs" r ON r."id" = s."syncRunId"
WHERE s."source" = 'daily'::"SummarySource"
  AND s."syncRunId" IS NOT NULL
  AND (s."distilledTier" = 'noise' OR (s."distilledTier" IS NULL AND s."distilledScore" IS NULL))
  AND NOT EXISTS (
    SELECT 1
    FROM "radar_sync_diagnostics" d
    WHERE d."runId" = s."syncRunId"
      AND d."canonicalUrl" = s."canonicalUrl"
      AND d."kind" = 'filtered'::"RadarDiagnosticKind"
  );
