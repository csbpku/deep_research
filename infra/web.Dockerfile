# Multi-stage Dockerfile for the Next.js Web app (apps/web).
#
# Build:
#   docker build -f infra/web.Dockerfile -t deep-research-web .
# Run:
#   docker run --rm -p 3000:3000 --env-file apps/web/.env deep-research-web

# ──────────────────────────── Stage 1: deps ────────────────────────────
FROM --platform=linux/amd64 node:20-alpine AS deps
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Use hoisted node_modules — Next.js needs flat structure for internal requires
RUN echo "node-linker=hoisted" > .npmrc
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --filter '@deep-research/web...' --filter '@deep-research/shared' \
    --frozen-lockfile

# ──────────────────────────── Stage 2: build ───────────────────────────
FROM deps AS build
WORKDIR /repo

COPY apps/web apps/web
COPY packages/shared packages/shared

RUN mkdir -p apps/web/public

RUN cd apps/web && pnpm db:generate

ENV NEXT_TELEMETRY_DISABLED=1
# Provide placeholder env vars for build-time validation (env.ts checks at import).
# Real values are injected at runtime via docker-compose environment.
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ENV NEXTAUTH_SECRET=placeholder-secret-for-build-only
ENV GOOGLE_CLIENT_ID=placeholder
ENV GOOGLE_CLIENT_SECRET=placeholder
ENV ALLOWED_EMAIL_DOMAINS=example.com
RUN cd apps/web && pnpm build

# ──────────────────────────── Stage 3: runner ──────────────────────────
FROM --platform=linux/amd64 node:20-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /repo

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next apps/web/.next
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/public apps/web/public
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/package.json apps/web/package.json
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/next.config.ts apps/web/next.config.ts
COPY --from=build --chown=nextjs:nodejs /repo/node_modules node_modules
COPY --from=build --chown=nextjs:nodejs /repo/packages packages
COPY --chown=nextjs:nodejs scripts/docker-entrypoint-web.sh /entrypoint.sh

WORKDIR /repo/apps/web

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/healthz || exit 1

ENTRYPOINT ["/entrypoint.sh"]
