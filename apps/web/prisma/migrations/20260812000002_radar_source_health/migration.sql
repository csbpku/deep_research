-- PR1 radar-source-health: surface per-source failure state on radar_sources.
--
-- `radar_sources.lastSyncAt` is updated on every terminal status (completed / partial / failed),
-- which is useful but does not distinguish "ran fine" from "failed loudly". Add four columns
-- so the admin dashboard and the next PR can render a 24h failure-rate widget without a join
-- against radar_sync_runs.

ALTER TABLE "radar_sources"
  ADD COLUMN "lastErrorCode"        VARCHAR(64),
  ADD COLUMN "lastErrorMessage"     VARCHAR(500),
  ADD COLUMN "lastErrorAt"          TIMESTAMPTZ(3),
  ADD COLUMN "consecutiveFailures"  INTEGER NOT NULL DEFAULT 0;

-- Partial index for the upcoming dashboard query: "sources stuck failing right now".
CREATE INDEX "radar_sources_consecutive_failures_idx"
  ON "radar_sources" ("consecutiveFailures")
  WHERE "consecutiveFailures" > 0;
