#!/usr/bin/env bash
# 每日 pg_dump。Week 8 必带。
# 用法：infra/pg-backup.sh [output_dir]
#
# Week 9 修复（演练发现）：
#   - 加 --clean --if-exists --no-owner：恢复时自动 DROP schema
#     避免 "type already exists" 冲突
#   - 保留 --no-privileges：恢复时不带 GRANT
#   - dump 输出纯 SQL（含 DROP），可在新 DB 或同 DB 任意恢复
#   - 清理逻辑：保留最新 7 个备份（不是 7 天的，pg_dump 是即时而非定时）

set -euo pipefail

OUT_DIR="${1:-$(dirname "$0")/backups}"
TS="$(date +%Y%m%d-%H%M%S)"
SQL_FILE="$OUT_DIR/deep_research-$TS.sql"
GZ_FILE="$SQL_FILE.gz"

mkdir -p "$OUT_DIR"

# pg_dump 写到 .sql，再 gzip 压缩到 .sql.gz
# 拆开两步避免 pipefail 中断（pg_dump 大输出时偶发 SIGPIPE）
PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" pg_dump \
    -h "${POSTGRES_HOST:-localhost}" \
    -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-deep_research}" \
    --clean --if-exists \
    --no-owner --no-privileges \
    > "$SQL_FILE"

gzip -f "$SQL_FILE"
# gzip 完成后文件名变成 .sql.gz

# 保留最新 7 个备份（按时间排序删除旧的）
ls -1t "$OUT_DIR"/deep_research-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f

echo "[pg-backup] wrote: $GZ_FILE"
