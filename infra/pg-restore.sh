#!/usr/bin/env bash
# 从 infra/pg-backup.sh 产生的 dump 恢复到 PostgreSQL。
# 用法：infra/pg-restore.sh <backup.sql.gz> [target_db]
#
# 行为：
#   - 校验传入文件存在且非空
#   - 解压为临时文件，gunzip 后交给 psql
#   - 默认恢复到 deep_research，可指定 target_db
#   - 恢复后逐表执行 COUNT(*)，便于与源库精确对照
#   - psql 失败 → 退出码非零，临时文件清理
#
# Week 9 收尾补全：
#   - 之前 W8 创建后被 dead-code 清理误删（commit 0cdc6d5 没动它，但实际盘上
#     缺失）。本周补回，保证"有 backup 必有 restore"成对。
#   - 行数校验：演练时人眼对照源库/目标库差异

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <backup.sql.gz> [target_db]" >&2
    echo "Example: $0 infra/backups/deep_research-20260728-164909.sql.gz deep_research_restore" >&2
    exit 2
fi

BACKUP_FILE="$1"
TARGET_DB="${2:-${POSTGRES_DB:-deep_research}}"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "[pg-restore] ERROR: backup file not found: $BACKUP_FILE" >&2
    exit 2
fi

if [ ! -s "$BACKUP_FILE" ]; then
    echo "[pg-restore] ERROR: backup file is empty: $BACKUP_FILE" >&2
    exit 2
fi

TMP_SQL="$(mktemp -t pg_restore_XXXXXX.sql)"
trap 'rm -f "$TMP_SQL"' EXIT

echo "[pg-restore] decompressing: $BACKUP_FILE"
gunzip -c "$BACKUP_FILE" > "$TMP_SQL"

echo "[pg-restore] restoring into database: $TARGET_DB"
echo "[pg-restore] (target must already exist; create it with: createdb -h \$HOST -U \$USER $TARGET_DB)"

PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" psql \
    -h "${POSTGRES_HOST:-localhost}" \
    -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER:-postgres}" \
    -d "$TARGET_DB" \
    -v ON_ERROR_STOP=1 \
    --single-transaction \
    -f "$TMP_SQL"

echo "[pg-restore] restore OK. Verifying row counts per table..."

# 行数校验：pg_class.reltuples 在刚恢复后常为 -1，只是规划器估算，不能作为
# 恢复证据。这里先生成每张表的安全引用 COUNT(*) SQL，再在目标库执行。
COUNT_SQL="$(PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" psql \
    -h "${POSTGRES_HOST:-localhost}" \
    -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER:-postgres}" \
    -d "$TARGET_DB" \
    -A -t -c "
        SELECT format(
          'SELECT %L || '': '' || count(*) FROM %I.%I;',
          schemaname || '.' || tablename,
          schemaname,
          tablename
        )
        FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, tablename;
    ")"

PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" psql \
    -h "${POSTGRES_HOST:-localhost}" \
    -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER:-postgres}" \
    -d "$TARGET_DB" \
    -A -t -v ON_ERROR_STOP=1 -c "$COUNT_SQL"

echo "[pg-restore] done."
