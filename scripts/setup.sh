#!/usr/bin/env bash
#
# Deep Research — one-command setup for new clones.
#
# Usage:
#   ./scripts/setup.sh            # interactive: prompts for config, full setup
#   ./scripts/setup.sh --quick    # non-interactive: fake adapter, zero API keys
#   ./scripts/setup.sh --docker   # interactive + Docker Compose build & deploy
#
# Prerequisites vary by mode:
#   local:  Node.js >= 20, pnpm >= 10, Python >= 3.11, uv, PostgreSQL 16
#   docker: Docker + docker compose

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }
step()  { echo -e "\n${BOLD}${CYAN}▶ $1${NC}"; }

# ── arg parsing ──────────────────────────────────────────────────
MODE="interactive"
for arg in "$@"; do
  case "$arg" in
    --quick)  MODE="quick" ;;
    --docker) MODE="docker" ;;
    *)        fail "Unknown option: $arg. Usage: $0 [--quick|--docker]" ;;
  esac
done

# ── helpers ──────────────────────────────────────────────────────
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c "import secrets; print(secrets.token_hex(32))"
  fi
}

gen_pg_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    python3 -c "import secrets; print(secrets.token_hex(16))"
  fi
}

prompt() {
  local question="$1"
  local default="$2"
  local var_name="$3"
  local answer
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${CYAN}${question}${NC} [${default}]: ")" answer
    printf -v "$var_name" '%s' "${answer:-$default}"
  else
    read -rp "$(echo -e "${CYAN}${question}${NC}: ")" answer
    printf -v "$var_name" '%s' "$answer"
  fi
}

prompt_secret() {
  local question="$1"
  local var_name="$2"
  local answer
  read -rsp "$(echo -e "${CYAN}${question}${NC} (input hidden, Enter to skip): ")" answer
  echo ""
  printf -v "$var_name" '%s' "$answer"
}

prompt_choice() {
  local question="$1"
  shift
  local var_name="$1"
  shift
  local options=("$@")
  local i=1
  echo -e "${CYAN}${question}${NC}"
  for opt in "${options[@]}"; do
    echo -e "  ${BOLD}$i${NC}) ${opt}"
    ((i++))
  done
  local choice
  read -rp "$(echo -e "${CYAN}Choose [1-${#options[@]}]${NC}: ")" choice
  printf -v "$var_name" '%s' "${choice:-1}"
}

# ════════════════════════════════════════════════════════════════
# DOCKER MODE
# ════════════════════════════════════════════════════════════════
if [[ "$MODE" == "docker" ]]; then
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║  Deep Research — Docker Compose Setup        ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"

  command -v docker >/dev/null 2>&1 || fail "Docker not found. Install: https://docs.docker.com/get-docker/"
  docker info >/dev/null 2>&1 || fail "Docker daemon not running. Start Docker Desktop or colima first."
  info "Docker is available"

  step "Configure deployment"

  prompt "Deploy URL (for NextAuth callback)" "http://localhost:3000" DEPLOY_URL
  prompt "Email domain allowlist (comma-separated)" "gmail.com" EMAIL_DOMAINS

  prompt_choice "Choose LLM provider:" LLM_CHOICE \
    "Anthropic (direct API — needs key)" \
    "OpenAI-compatible proxy (custom base URL)" \
    "Skip LLM for now (fake adapter — UI only)"

  case "$LLM_CHOICE" in
    1)
      prompt_secret "Anthropic API key" ANTHROPIC_KEY
      ANTHROPIC_BASE_URL_VAL=""
      ADAPTER_VAL="gpt_researcher"
      ;;
    2)
      prompt "LLM base URL (e.g. http://host.docker.internal:8318/v1)" "" LLM_BASE_URL
      prompt_secret "LLM API key" ANTHROPIC_KEY
      ANTHROPIC_BASE_URL_VAL="$LLM_BASE_URL"
      ADAPTER_VAL="gpt_researcher"
      ;;
    3)
      ANTHROPIC_KEY=""
      ANTHROPIC_BASE_URL_VAL=""
      ADAPTER_VAL="fake"
      ;;
  esac

  if [[ "$ADAPTER_VAL" != "fake" ]]; then
    prompt_choice "Choose web search provider:" SEARCH_CHOICE \
      "Tavily (needs API key — free at tavily.com)" \
      "DuckDuckGo (free, no key needed)" \
      "Skip search for now"

    case "$SEARCH_CHOICE" in
      1) prompt_secret "Tavily API key" TAVILY_KEY; RETRIEVER_VAL="tavily" ;;
      2) TAVILY_KEY=""; RETRIEVER_VAL="duckduckgo" ;;
      3) TAVILY_KEY=""; RETRIEVER_VAL="tavily" ;;
    esac
  else
    TAVILY_KEY=""
    RETRIEVER_VAL="tavily"
  fi

  prompt_choice "Configure Google OAuth login?" OAUTH_CHOICE \
    "Yes — I have Client ID / Secret" \
    "Skip (login disabled, browse freely)"

  case "$OAUTH_CHOICE" in
    1)
      prompt "Google OAuth Client ID" "" GOOGLE_ID
      prompt_secret "Google OAuth Client Secret" GOOGLE_SECRET
      ;;
    2)
      GOOGLE_ID=""
      GOOGLE_SECRET=""
      ;;
  esac

  PG_PASS=$(gen_pg_password)
  AUTH_SECRET=$(gen_secret)

  step "Generating .env"

  if [[ -f .env ]]; then
    warn ".env exists, backing up to .env.bak"
    cp .env .env.bak
  fi

  cat > .env << ENVFILE
# Auto-generated by scripts/setup.sh — $(date -Iseconds)
POSTGRES_PASSWORD=${PG_PASS}
NEXTAUTH_SECRET=${AUTH_SECRET}
NEXTAUTH_URL=${DEPLOY_URL}
ALLOWED_EMAIL_DOMAINS=${EMAIL_DOMAINS}

# LLM
AI_ENGINE_ADAPTER=${ADAPTER_VAL}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL_VAL}
SMART_LLM=anthropic:claude-haiku-4-5@20251001
FAST_LLM=anthropic:deepseek-v4-flash
STRATEGIC_LLM=anthropic:claude-haiku-4-5@20251001

# Search
TAVILY_API_KEY=${TAVILY_KEY}
RETRIEVER=${RETRIEVER_VAL}

# Google OAuth
GOOGLE_CLIENT_ID=${GOOGLE_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}

# Optional radar tokens
GH_TOKEN=
PRODUCTHUNT_API_TOKEN=
ENVFILE

  info ".env generated"

  step "Building Docker images"
  docker compose -f infra/docker-compose.yml build || fail "Docker build failed"
  info "Images built"

  step "Starting services"
  docker compose -f infra/docker-compose.yml up -d || fail "docker compose up failed"
  sleep 5

  step "Applying database migrations"
  for i in $(seq 1 15); do
    if docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
      break
    fi
    echo "  Waiting for PostgreSQL... ($i/15)"
    sleep 2
  done

  DATABASE_URL="postgresql://postgres:${PG_PASS}@localhost:5432/deep_research" \
    pnpm db:migrate 2>/dev/null \
    && info "Migrations applied" \
    || warn "Migration via host failed. Run inside container: docker compose -f infra/docker-compose.yml exec web pnpm db:migrate"

  pnpm db:generate 2>/dev/null && info "Prisma client generated" || true

  step "Checking service health"
  sleep 3
  WEB_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/healthz 2>/dev/null || echo "000")
  AI_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/healthz 2>/dev/null || echo "000")

  [[ "$WEB_HEALTH" == "200" ]] && info "Web: healthy (200)" || warn "Web: HTTP $WEB_HEALTH (may need a few more seconds)"
  [[ "$AI_HEALTH" == "200" ]] && info "AI Engine: healthy (200)" || warn "AI Engine: HTTP $AI_HEALTH (may need a few more seconds)"

  echo ""
  echo -e "${BOLD}${GREEN}Docker deployment complete!${NC}"
  echo ""
  echo -e "  Web:        ${DEPLOY_URL}"
  echo -e "  AI Engine:  http://localhost:4000"
  echo ""
  echo "  Logs:       docker compose -f infra/docker-compose.yml logs -f"
  echo "  Stop:       docker compose -f infra/docker-compose.yml down"
  echo "  Stop+data:  docker compose -f infra/docker-compose.yml down -v"
  echo ""
  exit 0
fi

# ════════════════════════════════════════════════════════════════
# LOCAL DEV MODE (interactive or quick)
# ════════════════════════════════════════════════════════════════

echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║  Deep Research — Local Dev Setup              ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"

step "Checking prerequisites"

command -v node    >/dev/null 2>&1 || fail "Node.js not found. Install Node.js >= 20 (https://nodejs.org/)"
command -v pnpm    >/dev/null 2>&1 || {
  warn "pnpm not found. Enabling via corepack..."
  corepack enable && corepack prepare pnpm@latest --activate \
    || fail "Failed to install pnpm. Run: npm install -g pnpm"
}
command -v python3 >/dev/null 2>&1 || fail "Python 3 not found. Install Python >= 3.11 (https://python.org/)"
command -v uv      >/dev/null 2>&1 || fail "uv not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
command -v psql    >/dev/null 2>&1 || warn "psql not found — PostgreSQL client tools recommended"

PYVER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PYVER_OK=$(python3 -c 'import sys; print(1 if sys.version_info >= (3,11) else 0)')
[[ "$PYVER_OK" == "1" ]] || fail "Python $PYVER found, need >= 3.11"

NODEVER=$(node -v | sed 's/v//' | cut -d. -f1)
[[ "$NODEVER" -ge 20 ]] || fail "Node.js $NODEVER found, need >= 20"

info "All prerequisites satisfied"

if [[ "$MODE" != "quick" ]]; then
  step "Configuration"

  prompt "PostgreSQL host" "localhost" PG_HOST
  prompt "PostgreSQL port" "5432" PG_PORT
  prompt "PostgreSQL user" "postgres" PG_USER
  prompt_secret "PostgreSQL password" PG_PASS_INPUT
  PG_PASS="${PG_PASS_INPUT:-postgres}"

  prompt "Email domain allowlist (comma-separated)" "gmail.com" EMAIL_DOMAINS

  prompt_choice "Choose LLM provider:" LLM_CHOICE \
    "Anthropic (direct API — needs key)" \
    "OpenAI-compatible proxy (custom base URL)" \
    "Fake adapter (no LLM calls — UI walkthrough only)"

  case "$LLM_CHOICE" in
    1)
      prompt_secret "Anthropic API key" ANTHROPIC_KEY
      LLM_BASE_URL=""
      ADAPTER_VAL="gpt_researcher"
      ;;
    2)
      prompt "LLM base URL (e.g. http://localhost:8318/v1)" "" LLM_BASE_URL
      prompt_secret "LLM API key" ANTHROPIC_KEY
      ADAPTER_VAL="gpt_researcher"
      ;;
    3)
      ANTHROPIC_KEY=""
      LLM_BASE_URL=""
      ADAPTER_VAL="fake"
      ;;
  esac

  if [[ "$ADAPTER_VAL" != "fake" ]]; then
    prompt_choice "Choose web search provider:" SEARCH_CHOICE \
      "Tavily (needs API key — free at tavily.com)" \
      "DuckDuckGo (free, no key needed)" \
      "Skip search for now"

    case "$SEARCH_CHOICE" in
      1) prompt_secret "Tavily API key" TAVILY_KEY; RETRIEVER_VAL="tavily" ;;
      2) TAVILY_KEY=""; RETRIEVER_VAL="duckduckgo" ;;
      3) TAVILY_KEY=""; RETRIEVER_VAL="tavily" ;;
    esac
  else
    TAVILY_KEY=""
    RETRIEVER_VAL="tavily"
  fi

  prompt_choice "Configure Google OAuth login?" OAUTH_CHOICE \
    "Yes — I have Client ID / Secret" \
    "Skip (login disabled)"

  case "$OAUTH_CHOICE" in
    1)
      prompt "Google OAuth Client ID" "" GOOGLE_ID
      prompt_secret "Google OAuth Client Secret" GOOGLE_SECRET
      ;;
    2)
      GOOGLE_ID=""
      GOOGLE_SECRET=""
      ;;
  esac
else
  PG_HOST="localhost"; PG_PORT="5432"; PG_USER="postgres"; PG_PASS="postgres"
  EMAIL_DOMAINS="gmail.com"
  ANTHROPIC_KEY=""; LLM_BASE_URL=""; ADAPTER_VAL="fake"
  TAVILY_KEY=""; RETRIEVER_VAL="tavily"
  GOOGLE_ID=""; GOOGLE_SECRET=""
fi

step "Installing JS dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
info "JS dependencies installed"

step "Setting up Python environment"
cd packages/ai-engine
uv sync
info "Python environment ready"
cd "$repo_root"

step "Generating environment files"

DB_URL="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/deep_research"
AUTH_SECRET=$(gen_secret)

cat > apps/web/.env << WEBENV
# Auto-generated by scripts/setup.sh
DATABASE_URL=${DB_URL}
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=${AUTH_SECRET}
AI_ENGINE_URL=http://localhost:4000
GOOGLE_CLIENT_ID=${GOOGLE_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}
ALLOWED_EMAIL_DOMAINS=${EMAIL_DOMAINS}
MAX_UPLOAD_SIZE_MB=5
TIME_VALUE_USD_PER_HOUR=50
WEBENV
info "apps/web/.env created"

cat > packages/ai-engine/.env << AIENV
# Auto-generated by scripts/setup.sh
DATABASE_URL=${DB_URL}
AI_ENGINE_ADAPTER=${ADAPTER_VAL}
TAVILY_API_KEY=${TAVILY_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
ANTHROPIC_BASE_URL=${LLM_BASE_URL}
ANTHROPIC_MODEL=claude-haiku-4-5@20251001
SMART_LLM=anthropic:claude-haiku-4-5@20251001
FAST_LLM=anthropic:deepseek-v4-flash
STRATEGIC_LLM=anthropic:claude-haiku-4-5@20251001
BRIEF_LLM=anthropic:deepseek-v4-flash
RETRIEVER=${RETRIEVER_VAL}
GH_TOKEN=
WORKER_LEASE_SECONDS=60
WORKER_HEARTBEAT_SECONDS=15
WORKER_MAX_RETRIES=3
WORKER_REAPER_INTERVAL_SECONDS=30
URL_FETCH_MAX_BYTES=2097152
URL_FETCH_TIMEOUT_SECONDS=10
URL_FETCH_MAX_REDIRECTS=3
BUDGET_TEAM_DAILY=20
BUDGET_USER_DAILY=5
AIENV
info "packages/ai-engine/.env created"

step "Setting up database"

if pg_isready -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1; then
  info "PostgreSQL is running"

  if ! PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -tc "SELECT 1 FROM pg_database WHERE datname='deep_research'" 2>/dev/null | grep -q 1; then
    PGPASSWORD="$PG_PASS" createdb -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" deep_research 2>/dev/null \
      && info "Database 'deep_research' created" \
      || warn "Could not create database — create it manually: createdb -h $PG_HOST -U $PG_USER deep_research"
  else
    info "Database 'deep_research' already exists"
  fi

  step "Running Prisma migrations"
  DATABASE_URL="$DB_URL" pnpm db:migrate && info "Migrations applied" \
    || warn "Migration failed — check DATABASE_URL in apps/web/.env"
  DATABASE_URL="$DB_URL" pnpm db:generate && info "Prisma client generated" || true
else
  warn "PostgreSQL not detected at ${PG_HOST}:${PG_PORT}"
  echo "  Start PostgreSQL, then run:"
  echo "    DATABASE_URL='${DB_URL}' pnpm db:migrate"
  echo "    DATABASE_URL='${DB_URL}' pnpm db:generate"
fi

echo ""
echo -e "${BOLD}${GREEN}Setup complete!${NC}"
echo ""
if [[ "$ADAPTER_VAL" == "fake" ]]; then
  echo -e "  ${YELLOW}Fake adapter${NC} — AI research returns mock data."
  echo -e "  UI is fully navigable, no API costs."
else
  if [[ -z "$ANTHROPIC_KEY" ]]; then
    echo -e "  ${YELLOW}⚠  ANTHROPIC_API_KEY is empty${NC} — edit packages/ai-engine/.env to enable real LLM"
  fi
  if [[ "$RETRIEVER_VAL" == "tavily" && -z "$TAVILY_KEY" ]]; then
    echo -e "  ${YELLOW}⚠  TAVILY_API_KEY is empty${NC} — edit packages/ai-engine/.env (or switch to DuckDuckGo)"
  fi
fi
echo ""
echo -e "${BOLD}Start services:${NC}"
echo "  pnpm dev:web    →  http://localhost:3000"
echo "  pnpm dev:ai     →  http://localhost:4000  (separate terminal)"
echo ""
if [[ -z "$GOOGLE_ID" ]]; then
  echo "  Google OAuth: not configured (login disabled)"
  echo "  To enable: https://console.cloud.google.com/apis/credentials"
  echo "  Callback: http://localhost:3000/api/auth/callback/google"
fi
echo ""
echo "  Docker alternative: ./scripts/setup.sh --docker"
echo ""
