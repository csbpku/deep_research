#!/usr/bin/env sh
# Docker entrypoint for web: run Prisma migrations, then idempotently bootstrap
# the initial Admin and default radar sources, then start Next.js.
#
# Bootstrap uses shaobo.chen@shopee.com by default (+ ALLOWED_EMAIL_DOMAINS for the
# allowlist). Set BOOTSTRAP_ADMIN_EMAIL=off to skip it explicitly.
set -e

APP_ROOT="/app/apps/web"
PRISMA_BIN="/app/node_modules/prisma/build/index.js"
TSX_BIN="/app/node_modules/.bin/tsx"

echo "[entrypoint] Running Prisma migrations..."
node "$PRISMA_BIN" migrate deploy --schema "$APP_ROOT/prisma/schema.prisma" 2>&1 || {
  echo "[entrypoint] Migration failed, continuing anyway (DB may already be migrated)"
}

if [ "${BOOTSTRAP_ADMIN_EMAIL:-}" != "off" ] && [ "${BOOTSTRAP_ADMIN_EMAIL:-}" != "disabled" ]; then
  echo "[entrypoint] Bootstrapping initial Admin..."
  cd "$APP_ROOT"
  node "$PRISMA_BIN" generate --schema "$APP_ROOT/prisma/schema.prisma" >/dev/null 2>&1 || true
  if [ -x "$TSX_BIN" ]; then
    BOOTSTRAP_ADMIN_EMAIL="$BOOTSTRAP_ADMIN_EMAIL" \
      ALLOWED_EMAIL_DOMAINS="${ALLOWED_EMAIL_DOMAINS:-}" \
      DATABASE_URL="$DATABASE_URL" \
      "$TSX_BIN" "$APP_ROOT/scripts/bootstrap-admin.ts" \
      || echo "[entrypoint] bootstrap-admin returned non-zero (see logs above); continuing"
  else
    echo "[entrypoint] tsx not found; skipping bootstrap-admin (run pnpm bootstrap:admin manually)"
  fi
else
  echo "[entrypoint] BOOTSTRAP_ADMIN_EMAIL disabled; skipping initial Admin bootstrap"
fi

echo "[entrypoint] Ensuring default radar sources..."
if [ -x "$TSX_BIN" ]; then
  DATABASE_URL="$DATABASE_URL" \
    "$TSX_BIN" "$APP_ROOT/scripts/bootstrap-radar-sources.ts" \
    || echo "[entrypoint] bootstrap-radar-sources returned non-zero (see logs above); continuing"
else
  echo "[entrypoint] tsx not found; skipping default radar source bootstrap"
fi

echo "[entrypoint] Starting Next.js standalone server..."
cd "$APP_ROOT"
exec node "$APP_ROOT/server.js"
