#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/deep_research_test'
export TEST_ANYTHINGLLM_URL='http://127.0.0.1:3002'
export DATABASE_URL="$TEST_DATABASE_URL"
printf 'AnythingLLM REST API key (hidden): '
IFS= read -r -s TEST_ANYTHINGLLM_API_KEY
printf '\n'
if [[ -z "$TEST_ANYTHINGLLM_API_KEY" ]]; then
  printf 'A REST API key is required.\n' >&2
  exit 2
fi
export TEST_ANYTHINGLLM_API_KEY

free_loopback_port() {
  node -e "const net = require('node:net'); const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); console.log(address.port); server.close(); });"
}

AI_ENGINE_PORT="$(free_loopback_port)"
WEB_PORT="$(free_loopback_port)"
export AI_ENGINE_URL="http://127.0.0.1:${AI_ENGINE_PORT}"
export E2E_BASE_URL="http://127.0.0.1:${WEB_PORT}"
export INTERNAL_SERVICE_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
export E2E_PERSONAL_KNOWLEDGE_LIVE=1
export UV_CACHE_DIR="${UV_CACHE_DIR:-/private/tmp/deep-research-uv-cache}"

API_PID=''
cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  unset TEST_ANYTHINGLLM_API_KEY TEST_ANYTHINGLLM_URL TEST_DATABASE_URL INTERNAL_SERVICE_TOKEN
}
trap cleanup EXIT INT TERM

(
  cd "$ROOT/packages/ai-engine"
  export ANYTHINGLLM_URL="$TEST_ANYTHINGLLM_URL"
  export ANYTHINGLLM_API_KEY="$TEST_ANYTHINGLLM_API_KEY"
  export ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED=1
  exec uv run --no-sync uvicorn tests.personal_knowledge_live_api:app \
    --host 127.0.0.1 --port "$AI_ENGINE_PORT"
) >/dev/null 2>&1 &
API_PID=$!

ready=0
for _ in {1..60}; do
  if curl --fail --silent "$AI_ENGINE_URL/openapi.json" >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if [[ "$ready" != 1 ]]; then
  printf 'Local AI Engine search API did not start.\n' >&2
  exit 1
fi

cd "$ROOT/apps/web"
./node_modules/.bin/playwright test --config ./playwright.config.ts \
  e2e/personal-knowledge-live-flows.spec.ts --workers=1
