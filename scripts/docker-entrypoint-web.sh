#!/usr/bin/env sh
# Docker entrypoint for web: run Prisma migrations then start Next.js.
set -e

NEXT_BIN=$(find /repo/node_modules/.pnpm -path '*/next/dist/bin/next' 2>/dev/null | head -1)
PRISMA_BIN=$(find /repo/node_modules/.pnpm -path '*/prisma/build/index.js' 2>/dev/null | head -1)

echo "[entrypoint] Running Prisma migrations..."
node "$PRISMA_BIN" migrate deploy --schema /repo/apps/web/prisma/schema.prisma 2>&1 || {
  echo "[entrypoint] Migration failed, continuing anyway (DB may already be migrated)"
}
echo "[entrypoint] Starting Next.js..."
cd /repo/apps/web
exec node "$NEXT_BIN" start -p 3000
