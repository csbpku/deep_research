#!/bin/sh
# 每日 pg_dump。Week 8 必带。
# 用法：infra/pg-backup.sh [output_dir]
#   宿主机：  infra/pg-backup.sh [dir]（POSTGRES_HOST 等环境变量见下）
#   容器内：  docker compose --env-file .env -f infra/docker-compose.yml \
#               exec -T -u root postgres /usr/local/bin/pg-backup.sh /backups
#   本脚本是 POSIX sh（postgres:16-alpine 无 bash）；失败时清理半成品文件并返回非 0。
#   本脚本不自带调度；定时执行需运维自行配置（示例见 infra/README.md）。
#
# Week 9 修复（演练发现）：
#   - 加 --clean --if-exists --no-owner：恢复时自动 DROP schema
#     避免 "type already exists" 冲突
#   - 保留 --no-privileges：恢复时不带 GRANT
#   - dump 输出纯 SQL（含 DROP），可在新 DB 或同 DB 任意恢复
#   - 清理逻辑：保留最新 7 个备份（不是 7 天的，pg_dump 是即时而非定时）

set -eu
# pipefail is not in every POSIX sh; enable when available (busybox ash / bash / dash>=0.5.12).
( set -o pipefail ) 2>/dev/null && set -o pipefail

umask 077   # dumps contain user data
OUT_DIR="${1:-$(dirname "$0")/backups}"
TS="$(date +%Y%m%d-%H%M%S)"
SQL_FILE="$OUT_DIR/deep_research-$TS.sql"
GZ_FILE="$SQL_FILE.gz"

mkdir -p "$OUT_DIR"

# On any failure/interrupt, drop the partial dump so a truncated file is never
# mistaken for a good backup (and never counted in retention).
cleanup_partial() {
    rc=$?
    if [ "$rc" -ne 0 ]; then
        rm -f "$SQL_FILE" "$GZ_FILE" "$GZ_FILE.tmp"
        echo "[pg-backup] FAILED (exit $rc); removed partial output" >&2
    fi
}
trap cleanup_partial EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

# 先压缩到临时名，成功后再 mv，避免半截 .sql.gz 被当作有效备份
gzip -c "$SQL_FILE" > "$GZ_FILE.tmp"
mv -f "$GZ_FILE.tmp" "$GZ_FILE"
rm -f "$SQL_FILE"
# gzip 完成后文件名变成 .sql.gz

# 保留最新 7 个备份（按时间排序删除旧的）
ls -1t "$OUT_DIR"/deep_research-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f || true

echo "[pg-backup] wrote: $GZ_FILE"
