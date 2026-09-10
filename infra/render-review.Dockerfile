FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && npm init -y \
    && npm install --no-fund --no-audit --omit=dev @playwright/test@1.62.0 \
    && npm cache clean --force \
    && useradd --create-home --uid 1001 renderreview \
    && chown -R renderreview:renderreview /app

COPY apps/web/scripts/radar-render-review.mjs /app/radar-render-review.mjs
COPY infra/render-review-server.mjs /app/render-review-server.mjs

ENV NODE_ENV=production \
    RENDER_REVIEW_PORT=4100 \
    RADAR_RENDER_REVIEW_BASE_URL=http://web:3000 \
    RADAR_RENDER_REVIEW_EXECUTABLE_PATH=/usr/bin/chromium

USER renderreview

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/healthz').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "/app/render-review-server.mjs"]
