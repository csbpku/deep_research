#!/usr/bin/env bash
set -euo pipefail

# Repeat bounded, resumable batches until every synced daily collection or
# deep_read record with a supported originalKind has enrichmentVersion=2.0.
# skim remains on its lightweight summary path; noise is intentionally ignored.

cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-$PWD/.venv/bin/python}"
BATCH_LIMIT="${BATCH_LIMIT:-200}"
BATCH_SIZE="${BATCH_SIZE:-4}"
CONCURRENCY="${CONCURRENCY:-2}"
ITEM_TIMEOUT="${ITEM_TIMEOUT:-600}"
ZREAD_TIMEOUT="${ZREAD_TIMEOUT:-900}"
LOG_FILE="${LOG_FILE:-/tmp/deep-research-full-radar-migration.log}"

exec >>"$LOG_FILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S %z')] full radar migration started"
while true; do
  remaining="$(
    psql -h localhost -U postgres -d deep_research -Atc "
      SELECT COUNT(*)
      FROM summaries
      WHERE source = 'daily'
        AND \"syncRunId\" IS NOT NULL
        AND \"status\" IN ('candidate','published')
        AND \"distilledTier\" IN ('collection','deep_read')
        AND \"originalKind\" IN ('github_repo','github_other','github_release','arxiv','rss','web_share')
        AND COALESCE(\"originalMeta\"->>'enrichmentVersion','') <> '2.0';
    " | tr -d '[:space:]'
  )"
  echo "[$(date '+%Y-%m-%d %H:%M:%S %z')] remaining=$remaining"
  if [[ "$remaining" == "0" ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S %z')] full radar migration completed"
    break
  fi

  "$PYTHON" scripts/migrate_existing_radar.py \
    --limit "$BATCH_LIMIT" \
    --batch-size "$BATCH_SIZE" \
    --concurrency "$CONCURRENCY" \
    --item-timeout "$ITEM_TIMEOUT" \
    --zread-timeout "$ZREAD_TIMEOUT"
done
