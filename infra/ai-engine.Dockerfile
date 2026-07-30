# Multi-stage Dockerfile for the AI engine (packages/ai-engine).
#
# Build:
#   docker build -f infra/ai-engine.Dockerfile -t deep-research-ai .
# Run:
#   docker run --rm -p 4000:4000 --env-file packages/ai-engine/.env deep-research-ai

# ──────────────────────────── Stage 1: deps ────────────────────────────
FROM python:3.11-slim AS deps
WORKDIR /app

RUN pip install --no-cache-dir uv==0.5.20

COPY packages/ai-engine/pyproject.toml packages/ai-engine/uv.lock* /app/packages/ai-engine/

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libffi-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app/packages/ai-engine
RUN uv sync --no-dev --no-install-project

# ──────────────────────────── Stage 2: runtime ──────────────────────────
FROM python:3.11-slim AS runtime
WORKDIR /app

COPY --from=deps /app/packages/ai-engine/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AI_ENGINE_HOST=0.0.0.0 \
    AI_ENGINE_PORT=4000

COPY packages/ai-engine /app

RUN useradd -m -u 1001 aiuser && chown -R aiuser /app
USER aiuser

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD /app/.venv/bin/python -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://localhost:4000/healthz', timeout=3).status == 200 else 1)"

CMD ["/app/.venv/bin/python", "-m", "uvicorn", "ai_engine.server.app:app", "--host", "0.0.0.0", "--port", "4000"]
