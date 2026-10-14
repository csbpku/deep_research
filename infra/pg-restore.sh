#!/usr/bin/env bash
# 从 infra/pg-backup.sh 产生的 dump 恢复到 PostgreSQL。
# 用法：infra/pg-restore.sh <backup.sql.gz> [target_db] [--yes] [--confirm-db NAME] [--dry-run]
#   恢复会覆盖目标库；默认需交互确认，生产默认库 deep_research 需 --yes --confirm-db deep_research。
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

# ── 参数 ────────────────────────────────────────────────────────
#   <backup.sql.gz>            必填
#   [target_db] | --target-db  目标库（默认 $POSTGRES_DB 或 deep_research）
#   --yes                      跳过交互确认（非交互/CI 必须显式给出）
#   --confirm-db <name>        非交互地确认「生产默认库」名；恢复到 deep_research 时
#                              必须同时给 --yes 和 --confirm-db deep_research
#                              （交互时改为手动键入库名）
#   --dry-run                  只校验参数/文件并打印将执行的动作，不连接任何数据库
PROD_DB="deep_research"
BACKUP_FILE=""
TARGET_DB=""
ASSUME_YES=false
CONFIRM_DB=""
DRY_RUN=false

usage() {
    echo "Usage: $0 <backup.sql.gz> [target_db] [--target-db NAME] [--yes] [--confirm-db NAME] [--dry-run]" >&2
    echo "Example: $0 infra/backups/deep_research-20260728-164909.sql.gz deep_research_restore --yes" >&2
    echo "Restoring into '$PROD_DB' needs --yes --confirm-db $PROD_DB (or typing the name interactively)." >&2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --yes|-y) ASSUME_YES=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --target-db) [ $# -ge 2 ] || { usage; exit 2; }; TARGET_DB="$2"; shift 2 ;;
        --confirm-db) [ $# -ge 2 ] || { usage; exit 2; }; CONFIRM_DB="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --*) echo "[pg-restore] ERROR: unknown option: $1" >&2; usage; exit 2 ;;
        *)
            if [ -z "$BACKUP_FILE" ]; then BACKUP_FILE="$1"
            elif [ -z "$TARGET_DB" ]; then TARGET_DB="$1"
            else echo "[pg-restore] ERROR: unexpected argument: $1" >&2; usage; exit 2; fi
            shift ;;
    esac
done

if [ -z "$BACKUP_FILE" ]; then usage; exit 2; fi
TARGET_DB="${TARGET_DB:-${POSTGRES_DB:-$PROD_DB}}"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "[pg-restore] ERROR: backup file not found: $BACKUP_FILE" >&2
    exit 2
fi

if [ ! -s "$BACKUP_FILE" ]; then
    echo "[pg-restore] ERROR: backup file is empty: $BACKUP_FILE" >&2
    exit 2
fi

# ── 确认 ────────────────────────────────────────────────────────
# 备份是 --clean --if-exists 的纯 SQL：恢复会 DROP 后重建目标库内的同名对象，
# 会覆盖目标库现有数据。必须经过显式确认。
TARGET_HOST="${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}"
echo "[pg-restore] about to OVERWRITE database '$TARGET_DB' on $TARGET_HOST from $BACKUP_FILE"
if [ "$DRY_RUN" = true ]; then
    echo "[pg-restore] dry-run: file OK; would restore into '$TARGET_DB' (no database contacted)."
    exit 0
fi

if [ "$TARGET_DB" = "$PROD_DB" ]; then
    # 生产默认库：--yes 之外还必须确认库名
    if [ "$ASSUME_YES" = true ]; then
        if [ "$CONFIRM_DB" != "$PROD_DB" ]; then
            echo "[pg-restore] REFUSING: '$PROD_DB' is the production default database." >&2
            echo "[pg-restore] Pass --confirm-db $PROD_DB together with --yes, or restore into a different --target-db first." >&2
            exit 3
        fi
    elif [ -t 0 ]; then
        printf "[pg-restore] This is the production default database. Type its name (%s) to continue: " "$PROD_DB"
        read -r typed
        if [ "$typed" != "$PROD_DB" ]; then echo "[pg-restore] aborted." >&2; exit 3; fi
    else
        echo "[pg-restore] REFUSING: non-interactive restore into '$PROD_DB' needs --yes --confirm-db $PROD_DB." >&2
        exit 3
    fi
elif [ "$ASSUME_YES" != true ]; then
    if [ -t 0 ]; then
        printf "[pg-restore] Overwrite database '%s'? [y/N] " "$TARGET_DB"
        read -r ans
        case "$ans" in y|Y|yes|YES) ;; *) echo "[pg-restore] aborted." >&2; exit 3 ;; esac
    else
        echo "[pg-restore] REFUSING: non-interactive run needs --yes." >&2
        exit 3
    fi
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
