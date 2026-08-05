#!/usr/bin/env sh
# Docker entrypoint for web: run Prisma migrations, then idempotently bootstrap
# the initial Admin (P1-A1), then start Next.js.
#
# Bootstrap requires BOOTSTRAP_ADMIN_EMAIL (+ ALLOWED_EMAIL_DOMAINS for the
# allowlist). If unset the script logs [skip] and proceeds — the Admin role is
# then assigned manually via the Admin console (P1-A3).
set -e

NEXT_BIN="/repo/node_modules/next/dist/bin/next"
PRISMA_BIN="/repo/node_modules/prisma/build/index.js"

# Keep compatibility with isolated pnpm layouts used by older images.
if [ ! -f "$NEXT_BIN" ]; then
  NEXT_BIN=$(find /repo/node_modules/.pnpm -path '*/next/dist/bin/next' 2>/dev/null | head -1)
fi
if [ ! -f "$PRISMA_BIN" ]; then
  PRISMA_BIN=$(find /repo/node_modules/.pnpm -path '*/prisma/build/index.js' 2>/dev/null | head -1)
fi

if [ -z "$NEXT_BIN" ] || [ ! -f "$NEXT_BIN" ]; then
  echo "[entrypoint] Next.js runtime not found" >&2
  exit 1
fi

echo "[entrypoint] Running Prisma migrations..."
node "$PRISMA_BIN" migrate deploy --schema /repo/apps/web/prisma/schema.prisma 2>&1 || {
  echo "[entrypoint] Migration failed, continuing anyway (DB may already be migrated)"
}

if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ]; then
  echo "[entrypoint] Bootstrapping initial Admin (BOOTSTRAP_ADMIN_EMAIL set)..."
  cd /repo/apps/web
  node "$PRISMA_BIN" generate --schema /repo/apps/web/prisma/schema.prisma >/dev/null 2>&1 || true
  if [ -x /repo/node_modules/.bin/tsx ]; then
    BOOTSTRAP_ADMIN_EMAIL="$BOOTSTRAP_ADMIN_EMAIL" \
      ALLOWED_EMAIL_DOMAINS="${ALLOWED_EMAIL_DOMAINS:-}" \
      DATABASE_URL="$DATABASE_URL" \
      /repo/node_modules/.bin/tsx /repo/apps/web/scripts/bootstrap-admin.ts \
      || echo "[entrypoint] bootstrap-admin returned non-zero (see logs above); continuing"
  else
    echo "[entrypoint] tsx not found; skipping bootstrap-admin (run pnpm bootstrap:admin manually)"
  fi
else
  echo "[entrypoint] BOOTSTRAP_ADMIN_EMAIL unset; skipping initial Admin bootstrap"
fi

echo "[entrypoint] Starting Next.js..."
cd /repo/apps/web
exec node "$NEXT_BIN" start -p 3000
