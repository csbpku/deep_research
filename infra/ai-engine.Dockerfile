# Multi-stage Dockerfile for the AI engine (packages/ai-engine).
#
# Build:
#   docker build -f infra/ai-engine.Dockerfile -t deep-research-ai .
# Run:
#   docker run --rm -p 4000:4000 --env-file packages/ai-engine/.env deep-research-ai

# ──────────────────────────── Stage 1: deps ────────────────────────────
FROM --platform=linux/amd64 python:3.11-slim AS deps
WORKDIR /app

RUN pip install --no-cache-dir uv==0.5.20

COPY packages/ai-engine/pyproject.toml packages/ai-engine/uv.lock* /app/packages/ai-engine/

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libffi-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app/packages/ai-engine
RUN uv sync --no-dev --no-install-project

# ──────────────────────────── Stage 2: runtime ──────────────────────────
FROM --platform=linux/amd64 python:3.11-slim AS runtime
WORKDIR /app

# The optional local Zread fallback is invoked as a subprocess by the Python
# enrichment worker. Keep it in the AI image (without Chromium) so the
# remote -> CLI -> README fallback order is real in production. Git is needed
# for commit-pinned resumable checkouts; Node/npm are only used when a CLI job
# starts.
ARG ZREAD_CLI_VERSION=0.2.13
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git nodejs npm \
    && npm install --global --no-fund --no-audit "zread_cli@${ZREAD_CLI_VERSION}" \
    && command -v zread \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1001 -U aiuser \
    && mkdir -p /data/import-tmp /data/zread \
    && chown aiuser:aiuser /app /data /data/import-tmp /data/zread

# Set ownership while files are copied. A recursive chown after copying the
# venv would duplicate the entire dependency tree in a separate image layer.
COPY --from=deps --chown=aiuser:aiuser /app/packages/ai-engine/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AI_ENGINE_HOST=0.0.0.0 \
    AI_ENGINE_PORT=4000

COPY --chown=aiuser:aiuser packages/ai-engine/ai_engine /app/ai_engine
COPY --chown=aiuser:aiuser packages/ai-engine/configs /app/configs
COPY --chown=aiuser:aiuser packages/ai-engine/scripts /app/scripts
USER aiuser

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD /app/.venv/bin/python -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://localhost:4000/healthz', timeout=3).status == 200 else 1)"

CMD ["/app/.venv/bin/python", "-m", "uvicorn", "ai_engine.server.app:app", "--host", "0.0.0.0", "--port", "4000"]
