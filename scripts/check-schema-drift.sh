#!/usr/bin/env bash
# Fail when prisma/schema.prisma drifts from the schema produced by the SQL
# migrations. Usage: DATABASE_URL=<migrated db> scripts/check-schema-drift.sh
#
# Known harmless differences (allow-listed below):
#   1. topics.synthesisVersion @default("v2")  -- applied by the Prisma client only; DB column has no default.
#   2. summaries_distilledProfile_distilledTotal_idx -- partial index in SQL (WHERE "syncRunId" IS NOT NULL),
#      Prisma 5 cannot express the predicate, so it always wants a full index.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point at a database with all migrations applied}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$ROOT/apps/web/prisma/schema.prisma"

sql="$(cd "$ROOT" && pnpm --silent --filter @deep-research/web exec prisma migrate diff \
  --from-url "$DATABASE_URL" --to-schema-datamodel "$SCHEMA" --script)"

# Drop comments/blank lines, then remove allow-listed statements.
unexpected="$(printf '%s\n' "$sql" | grep -vE '^\s*(--.*)?$' \
  | grep -vF 'ALTER TABLE "topics" ALTER COLUMN "synthesisVersion" SET DEFAULT '"'v2'"';' \
  | grep -vF 'CREATE INDEX "summaries_distilledProfile_distilledTotal_idx" ON "summaries"("distilledProfile", "distilledTotal" DESC);' \
  | grep -vF 'There are no differences between the Prisma schema and the database' || true)"

if [ -n "$unexpected" ]; then
  echo "::error::schema.prisma has drifted from the migrations. Unexpected differences:" >&2
  printf '%s\n' "$unexpected" >&2
  echo "Fix schema.prisma (or add a migration) so both agree; see scripts/check-schema-drift.sh for the allow-list." >&2
  exit 1
fi
echo "schema.prisma matches migrations (only allow-listed differences remain)."
