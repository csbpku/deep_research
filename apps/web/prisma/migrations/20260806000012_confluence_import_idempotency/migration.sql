-- A Confluence page/version may have only one active or successful import
-- per requester. Failed jobs remain retryable and are therefore excluded.
CREATE UNIQUE INDEX "content_import_jobs_confluence_identity_key"
ON "content_import_jobs" ("requesterId", "sourceKind", "externalPageId", "externalVersion")
WHERE "sourceKind" = 'confluence'
  AND "externalPageId" IS NOT NULL
  AND "externalVersion" IS NOT NULL
  AND "status" IN ('queued', 'running', 'succeeded');
