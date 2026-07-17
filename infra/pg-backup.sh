#!/usr/bin/env bash
# 每日 pg_dump。Week 8 必带。
# 用法：infra/pg-backup.sh [output_dir]
set -euo pipefail

OUT_DIR="${1:-$(dirname "$0")/backups}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$OUT_DIR/deep_research-$TS.sql.gz"

mkdir -p "$OUT_DIR"

PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" pg_dump \
    -h "${POSTGRES_HOST:-localhost}" \
    -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-deep_research}" \
    --no-owner --no-privileges \
    | gzip > "$OUT_FILE"

# 清理 > 7 天的备份
find "$OUT_DIR" -type f -name 'deep_research-*.sql.gz' -mtime +7 -delete

echo "[pg-backup] wrote: $OUT_FILE"
