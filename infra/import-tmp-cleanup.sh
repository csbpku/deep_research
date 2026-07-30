#!/usr/bin/env bash
# Clean up stale temp files in the import-tmp volume.
#
# Usage:
#   ./import-tmp-cleanup.sh                    # dry-run, report only
#   ./import-tmp-cleanup.sh --apply            # actually delete
#   ./import-tmp-cleanup.sh [temp_dir] [max_age_hours] [--apply]
#
# Default: scans /data/import-tmp (container mount point), removes files
# older than 24h. Always protects tempObjectKeys still referenced in
# content_import_jobs.
#
# Behaviour matches ai_engine.import_worker.cleanup_stale_import_files().

set -euo pipefail

fail() { echo "[import-tmp-cleanup] ERROR: $*" >&2; exit 1; }

APPLY=false
TEMP_DIR=""
MAX_AGE_HOURS=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --apply) APPLY=true; shift ;;
        --help|-h)
            echo "Usage: $0 [--apply] [temp_dir] [max_age_hours]"
            echo "  --apply   Actually delete files (default: dry-run only)"
            exit 0
            ;;
        *)
            if [ -z "$TEMP_DIR" ]; then TEMP_DIR="$1";
            elif [ -z "$MAX_AGE_HOURS" ]; then MAX_AGE_HOURS="$1";
            else fail "unexpected extra arg: $1"; fi
            shift
            ;;
    esac
done

# Defaults — prefer the container mount point.
: "${TEMP_DIR:=/data/import-tmp}"
: "${MAX_AGE_HOURS:=24}"

if [ ! -d "$TEMP_DIR" ]; then
    echo "[import-tmp-cleanup] nothing to do: $TEMP_DIR does not exist"
    exit 0
fi

echo "[import-tmp-cleanup] scanning: $TEMP_DIR (max_age=${MAX_AGE_HOURS}h, apply=$APPLY)"

# Pull the protected list from the DB if DATABASE_URL is available.
PROTECTED=""
DATABASE_URL="${DATABASE_URL:-}"
if [ -n "$DATABASE_URL" ] && command -v psql &>/dev/null; then
    PROTECTED=$(psql "${DATABASE_URL}" -A -t \
        -c 'SELECT "tempObjectKey" FROM content_import_jobs WHERE "tempObjectKey" IS NOT NULL;' \
        2>/dev/null || true)
fi

removed=0
kept=0
now=$(date +%s)
cutoff_seconds=$((MAX_AGE_HOURS * 3600))

while IFS= read -r -d '' path; do
    file_mtime=$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null || echo 0)
    age=$((now - file_mtime))
    if [ "$age" -le "$cutoff_seconds" ]; then
        continue
    fi
    name=$(basename "$path")
    if [ -n "$PROTECTED" ] && echo "$PROTECTED" | grep -qx "$name"; then
        echo "[import-tmp-cleanup] keep:  $name (referenced in DB)"
        kept=$((kept + 1))
    elif [ "$APPLY" = true ]; then
        rm -f "$path"
        echo "[import-tmp-cleanup] removed: $name"
        removed=$((removed + 1))
    else
        echo "[import-tmp-cleanup] dry-run would remove: $name"
        removed=$((removed + 1))
    fi
done < <(find "$TEMP_DIR" -maxdepth 1 -type f -print0 2>/dev/null)

echo "[import-tmp-cleanup] removed=$removed kept=$kept (apply=$APPLY)"
