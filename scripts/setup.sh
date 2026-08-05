#!/usr/bin/env bash
#
# Deep Research — one-command setup for new clones.
#
# Usage:
#   ./scripts/setup.sh                  # interactive, auto-detects best mode
#   ./scripts/setup.sh --quick          # non-interactive: fake adapter, zero API keys
#   ./scripts/setup.sh --docker         # interactive + Docker Compose build & deploy
#   ./scripts/setup.sh --vps --domain example.com  # generate VPS deployment pack
#
# Prerequisites vary by mode:
#   local:  Node.js >= 20, pnpm >= 10, Python >= 3.11, uv, PostgreSQL 16
#   docker: Docker + docker compose plugin
#   vps:    none (generates config files for remote deployment)

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
MODE="auto"
VPS_DOMAIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)      MODE="quick" ;;
    --docker)     MODE="docker" ;;
    --vps)        MODE="vps" ;;
    --domain)     VPS_DOMAIN="$2"; shift ;;
    --auto|"")    MODE="auto" ;;
    *)            fail "Unknown option: $1. Usage: $0 [--quick|--docker|--vps --domain <domain>]" ;;
  esac
  shift
done

# ── helpers ──────────────────────────────────────────────────────
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || echo "change-me-$(date +%s)"
  fi
}

gen_pg_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    python3 -c "import secrets; print(secrets.token_hex(16))" 2>/dev/null || echo "change-me-$(date +%s)"
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

validate_non_empty() {
  local value="$1" name="$2"
  if [[ -z "${value// }" ]]; then
    warn "${name} is empty — this may prevent the service from starting"
  fi
}

prompt_choice() {
  local question="$1"
  shift
  local var_name="$1"
  shift
  local options=("$@")
  echo -e "${CYAN}${question}${NC}"
  local i=1
  for opt in "${options[@]}"; do
    echo -e "  ${BOLD}$i${NC}) ${opt}"
    ((i++))
  done
  local choice
  read -rp "$(echo -e "${CYAN}Choose [1-${#options[@]}]${NC}: ")" choice
  printf -v "$var_name" '%s' "${choice:-1}"
}

detect_and_recommend() {
  echo -e "${CYAN}Detected environment:${NC}"
  local has_docker=false has_pg=false has_node=false has_pnpm=false has_python=false has_uv=false
  local arch="$(uname -m)"

  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && has_docker=true
  command -v psql >/dev/null 2>&1 && pg_isready >/dev/null 2>&1 && has_pg=true
  command -v node >/dev/null 2>&1 && has_node=true
  command -v pnpm >/dev/null 2>&1 && has_pnpm=true
  command -v python3 >/dev/null 2>&1 && has_python=true
  command -v uv >/dev/null 2>&1 && has_uv=true

  echo "  Docker:       $($has_docker && echo -e "${GREEN}running${NC}" || echo -e "${RED}not available${NC}")"
  echo "  PostgreSQL:   $($has_pg     && echo -e "${GREEN}running${NC}" || echo -e "${YELLOW}not detected${NC}")"
  echo "  Node:         $($has_node   && echo -e "${GREEN}$(node -v)${NC}" || echo -e "${RED}missing${NC}")"
  echo "  pnpm:         $($has_pnpm   && echo -e "${GREEN}$(pnpm -v)${NC}" || echo -e "${RED}missing${NC}")"
  echo "  Python:       $($has_python && echo -e "${GREEN}$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')${NC}" || echo -e "${RED}missing${NC}")"
  echo "  uv:           $($has_uv     && echo -e "${GREEN}$(uv --version | head -1)${NC}" || echo -e "${RED}missing${NC}")"
  echo "  Arch:         ${arch}"

  echo ""
  if $has_docker; then
    echo -e "  → ${BOLD}Recommended: ${GREEN}--docker${NC} (Docker Compose, easiest)"
    echo "    Other options: --quick (fake adapter, no keys) | --vps (generate remote deploy pack)"
  elif $has_node && $has_pnpm && $has_python && $has_uv && $has_pg; then
    echo -e "  → ${BOLD}Recommended: ${GREEN}interactive${NC} (local dev on bare metal)"
  elif $has_docker; then
    echo -e "  → ${BOLD}Recommended: ${GREEN}--docker${NC}"
  else
    echo -e "  → ${BOLD}Recommended: ${GREEN}--quick${NC} (minimal, browse the UI only)"
  fi

  if [[ "$arch" == "arm64" || "$arch" == "aarch64" ]]; then
    echo -e "  ${YELLOW}Note:${NC} You're on Apple Silicon. Dockerfiles build linux/amd64 for VPS compatibility."
  fi
}

# ── shared interactive prompts (used by docker, local, and vps modes) ──
run_interactive_prompts() {
  local deploy_url_default="$1"

  prompt "Deploy URL (for NextAuth callback)" "$deploy_url_default" DEPLOY_URL
  prompt "Email domain allowlist (comma-separated)" "gmail.com" EMAIL_DOMAINS
  validate_non_empty "$EMAIL_DOMAINS" "ALLOWED_EMAIL_DOMAINS"

  # P1-A1: collect initial Admin email (must belong to allowlist).
  local default_bootstrap="admin@${EMAIL_DOMAINS%%,*}"
  prompt "Initial Admin email (P1-A1 bootstrap; blank to skip)" "$default_bootstrap" BOOTSTRAP_ADMIN_EMAIL_INPUT
  BOOTSTRAP_ADMIN_EMAIL=""
  if [[ -n "${BOOTSTRAP_ADMIN_EMAIL_INPUT// }" ]]; then
    BOOTSTRAP_ADMIN_EMAIL="$(printf '%s' "$BOOTSTRAP_ADMIN_EMAIL_INPUT" | tr '[:upper:]' '[:lower:]')"
    local bootstrap_domain="${BOOTSTRAP_ADMIN_EMAIL##*@}"
    local matched=false
    IFS=',' read -r -a _allow <<< "$EMAIL_DOMAINS"
    for d in "${_allow[@]}"; do
      d="$(echo "$d" | tr '[:upper:]' '[:lower:]' | xargs)"
      if [[ "$d" == "$bootstrap_domain" ]]; then
        matched=true
        break
      fi
    done
    if [[ "$matched" != "true" ]]; then
      warn "Initial Admin 域名 $bootstrap_domain 不在 ALLOWED_EMAIL_DOMAINS 内；将留空，需在 Admin 控制台手动设置"
      BOOTSTRAP_ADMIN_EMAIL=""
    fi
  fi

  prompt_choice "Choose LLM provider:" LLM_CHOICE \
    "Anthropic (direct API — needs key)" \
    "OpenAI-compatible proxy (custom base URL)" \
    "Skip LLM for now (fake adapter — UI only)"

  case "$LLM_CHOICE" in
    1)
      prompt_secret "Anthropic API key" ANTHROPIC_KEY
      validate_non_empty "$ANTHROPIC_KEY" "ANTHROPIC_API_KEY"
      ANTHROPIC_BASE_URL_VAL=""
      ADAPTER_VAL="gpt_researcher"
      ;;
    2)
      prompt "LLM base URL (e.g. http://localhost:8318/v1)" "" LLM_BASE_URL
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
      1) prompt_secret "Tavily API key" TAVILY_KEY; validate_non_empty "$TAVILY_KEY" "TAVILY_API_KEY"; RETRIEVER_VAL="tavily" ;;
      2) TAVILY_KEY=""; RETRIEVER_VAL="duckduckgo" ;;
      3) TAVILY_KEY=""; RETRIEVER_VAL="tavily" ;;
    esac
  else
    TAVILY_KEY=""
    RETRIEVER_VAL="tavily"
  fi

  prompt_choice "Configure Google OAuth login?" OAUTH_CHOICE \
    "Yes — I have Client ID / Secret (from Google Cloud Console)" \
    "Skip (login disabled, browse freely)"

  case "$OAUTH_CHOICE" in
    1)
      prompt "Google OAuth Client ID" "" GOOGLE_ID
      prompt_secret "Google OAuth Client Secret" GOOGLE_SECRET
      validate_non_empty "$GOOGLE_ID" "GOOGLE_CLIENT_ID"
      validate_non_empty "$GOOGLE_SECRET" "GOOGLE_CLIENT_SECRET"
      echo -e "  ${YELLOW}Callback URL to register:${NC} ${DEPLOY_URL}/api/auth/callback/google"
      ;;
    2)
      GOOGLE_ID=""
      GOOGLE_SECRET=""
      ;;
  esac

  # Optional extras
  echo ""
  prompt_choice "Configure optional tokens?" OPT_CHOICE \
    "Skip all optional tokens" \
    "Set GitHub token (for radar GitHub sources)" \
    "Set both GitHub + ProductHunt tokens"

  case "$OPT_CHOICE" in
    1) GH_TOKEN_VAL=""; PH_TOKEN_VAL="" ;;
    2) prompt_secret "GitHub personal access token" GH_TOKEN_VAL; PH_TOKEN_VAL="" ;;
    3)
      prompt_secret "GitHub personal access token" GH_TOKEN_VAL
      prompt_secret "ProductHunt API token" PH_TOKEN_VAL
      ;;
  esac
}

write_root_env() {
  local out="${1:-.env}"
  cat > "$out" << ENVFILE
# Auto-generated by scripts/setup.sh — $(date -Iseconds)
# Mode: ${MODE}
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
BRIEF_LLM=anthropic:deepseek-v4-flash

# Search
TAVILY_API_KEY=${TAVILY_KEY}
RETRIEVER=${RETRIEVER_VAL}

# Google OAuth
GOOGLE_CLIENT_ID=${GOOGLE_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}

# Optional radar tokens
GH_TOKEN=${GH_TOKEN_VAL}
PRODUCTHUNT_API_TOKEN=${PH_TOKEN_VAL}

# P1-A1: initial Admin bootstrap (empty => skip)
BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_ADMIN_EMAIL:-}
ENVFILE
}

# ════════════════════════════════════════════════════════════════
# MODE: auto
# ════════════════════════════════════════════════════════════════
if [[ "$MODE" == "auto" ]]; then
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║  Deep Research — Environment Setup            ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"

  detect_and_recommend

  echo ""
  echo -e "${BOLD}Choose a setup mode:${NC}"
  echo "  1) Quick  — fake adapter, zero keys, browse UI immediately"
  echo "  2) Docker — Docker Compose, interactive config, full stack"
  echo "  3) Local  — interactive, bare-metal dev (Node + Python + PostgreSQL)"
  echo "  4) VPS    — generate deployment pack for remote VPS"
  read -rp "$(echo -e "${CYAN}Choose [1-4]${NC}: ")" mode_choice
  case "${mode_choice:-1}" in
    1) MODE="quick" ;;
    2) MODE="docker" ;;
    3) MODE="interactive" ;;
    4) MODE="vps"; prompt "VPS domain or IP" "example.com" VPS_DOMAIN ;;
    *) MODE="quick" ;;
  esac
  echo ""
fi

# ════════════════════════════════════════════════════════════════
# MODE: vps
# ════════════════════════════════════════════════════════════════
if [[ "$MODE" == "vps" ]]; then
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║  Deep Research — VPS Deployment Pack          ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"

  DEPLOY_URL_DEFAULT="https://${VPS_DOMAIN:-example.com}"
  PG_PASS=$(gen_pg_password)
  AUTH_SECRET=$(gen_secret)
  GH_TOKEN_VAL=""
  PH_TOKEN_VAL=""

  run_interactive_prompts "$DEPLOY_URL_DEFAULT"

  step "Generating VPS deployment pack"

  DEPLOY_DIR="$repo_root/deploy"
  rm -rf "$DEPLOY_DIR"
  mkdir -p "$DEPLOY_DIR/infra/certs"

  # Root .env
  write_root_env "$DEPLOY_DIR/.env"

  # Copy compose + nginx TLS config
  sed "s|nginx.conf|nginx-tls.conf|g" infra/docker-compose.yml > "$DEPLOY_DIR/infra/docker-compose.yml"
  cp infra/nginx-tls.conf "$DEPLOY_DIR/infra/nginx.conf"
  cp infra/import-tmp-cleanup.sh "$DEPLOY_DIR/infra/"
  cp infra/pg-backup.sh "$DEPLOY_DIR/infra/"
  cp infra/pg-restore.sh "$DEPLOY_DIR/infra/"
  cp infra/web.Dockerfile "$DEPLOY_DIR/infra/"
  cp infra/ai-engine.Dockerfile "$DEPLOY_DIR/infra/"
  cp scripts/docker-entrypoint-web.sh "$DEPLOY_DIR/infra/"
  cp infra/nginx-tls.conf "$DEPLOY_DIR/infra/"
  cp infra/.gitkeep "$DEPLOY_DIR/infra/certs/" 2>/dev/null || touch "$DEPLOY_DIR/infra/certs/.gitkeep"
  mkdir -p "$DEPLOY_DIR/infra/logs/web" "$DEPLOY_DIR/infra/logs/ai-engine" "$DEPLOY_DIR/infra/logs/nginx" "$DEPLOY_DIR/infra/backups"
  touch "$DEPLOY_DIR/infra/logs/web/.gitkeep" "$DEPLOY_DIR/infra/logs/ai-engine/.gitkeep" "$DEPLOY_DIR/infra/logs/nginx/.gitkeep" "$DEPLOY_DIR/infra/backups/.gitkeep"

  # VPS-side deploy script
  cat > "$DEPLOY_DIR/vps-deploy.sh" << 'VPSSCRIPT'
#!/usr/bin/env bash
set -euo pipefail

echo "=== Deep Research — VPS Deploy ==="
echo ""

# Detect OS
if [ -f /etc/os-release ]; then
  . /etc/os-release
  echo "OS: $NAME $VERSION"
fi
echo ""

# Install Docker if needed
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  if command -v yum >/dev/null 2>&1; then
    yum install -y docker
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y docker.io
  else
    echo "ERROR: Cannot install Docker automatically. Please install it manually."
    exit 1
  fi
  systemctl enable docker --now
fi

# Install compose plugin if needed
if ! docker compose version >/dev/null 2>&1; then
  echo "Installing Docker Compose plugin..."
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

# Set up swap if not present (critical for 2G RAM)
if ! swapon --show | grep -q swap; then
  echo "Setting up 2G swap..."
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "Building Docker images (this may take 5-15 minutes)..."
docker compose -f infra/docker-compose.yml build

echo "Starting services..."
docker compose -f infra/docker-compose.yml up -d

echo "Waiting for services to be healthy..."
sleep 10

# Health checks
for i in $(seq 1 15); do
  WEB=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/healthz 2>/dev/null || echo "000")
  if [ "$WEB" = "200" ]; then
    echo "Web: healthy"
    break
  fi
  echo "  Waiting... ($i/15) web HTTP $WEB"
  sleep 3
done

for i in $(seq 1 15); do
  AI=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/healthz 2>/dev/null || echo "000")
  if [ "$AI" = "200" ]; then
    echo "AI Engine: healthy"
    break
  fi
  echo "  Waiting... ($i/15) AI engine HTTP $AI"
  sleep 3
done

echo ""
echo "=== Deploy complete ==="
echo "  Visit: http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "  Manage:  docker compose -f infra/docker-compose.yml logs -f"
echo "  Backup:  docker compose -f infra/docker-compose.yml exec postgres /usr/local/bin/pg-backup.sh"
echo ""
VPSSCRIPT
  chmod +x "$DEPLOY_DIR/vps-deploy.sh"

  echo ""
  echo -e "${BOLD}${GREEN}VPS deployment pack ready!${NC}"
  echo ""
  echo -e "  Output: ${BOLD}${DEPLOY_DIR}${NC}"
  echo ""
  echo -e "${BOLD}Next steps:${NC}"
  echo "  1. Copy to VPS:"
  echo -e "     ${CYAN}rsync -avz deploy/ root@${VPS_DOMAIN:-<your-ip>}:/opt/deep-research/${NC}"
  echo ""
  echo "  2. On the VPS, run:"
  echo -e "     ${CYAN}cd /opt/deep-research && bash vps-deploy.sh${NC}"
  echo ""
  echo "  3. If using TLS:"
  echo "     Copy your SSL cert to /opt/deep-research/infra/certs/"
  echo "     (fullchain.pem + privkey.pem), then restart nginx:"
  echo -e "     ${CYAN}docker compose -f infra/docker-compose.yml restart nginx${NC}"
  echo ""

  if [[ -z "$GOOGLE_ID" ]]; then
    echo -e "  ${YELLOW}Google OAuth: not configured.${NC}"
    echo "  To enable, get credentials at https://console.cloud.google.com/apis/credentials"
    echo "  Callback URL: ${DEPLOY_URL}/api/auth/callback/google"
  fi

  exit 0
fi

# ════════════════════════════════════════════════════════════════
# MODE: docker
# ════════════════════════════════════════════════════════════════
if [[ "$MODE" == "docker" ]]; then
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║  Deep Research — Docker Compose Setup        ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"

  command -v docker >/dev/null 2>&1 || fail "Docker not found. Install: https://docs.docker.com/get-docker/"
  docker info >/dev/null 2>&1 || fail "Docker daemon not running. Start Docker Desktop or colima first."
  info "Docker is available"

  PG_PASS=$(gen_pg_password)
  AUTH_SECRET=$(gen_secret)
  GH_TOKEN_VAL=""
  PH_TOKEN_VAL=""

  run_interactive_prompts "http://localhost:3000"

  step "Generating .env"
  if [[ -f .env ]]; then
    warn ".env exists, backing up to .env.bak"
    cp .env .env.bak
  fi
  write_root_env ".env"
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

  if [[ "$ADAPTER_VAL" == "fake" ]]; then
    echo -e "  ${YELLOW}Fake adapter${NC} — AI research returns mock data."
  fi
  if [[ -z "$GOOGLE_ID" ]]; then
    echo -e "  ${YELLOW}Google OAuth: not configured${NC} (login disabled)"
  fi

  exit 0
fi

# ════════════════════════════════════════════════════════════════
# MODE: interactive (default local dev)
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

GH_TOKEN_VAL=""
PH_TOKEN_VAL=""

if [[ "$MODE" != "quick" ]]; then
  step "Configuration"

  prompt "PostgreSQL host" "localhost" PG_HOST
  prompt "PostgreSQL port" "5432" PG_PORT
  prompt "PostgreSQL user" "postgres" PG_USER
  prompt_secret "PostgreSQL password" PG_PASS_INPUT
  PG_PASS="${PG_PASS_INPUT:-postgres}"

  prompt "Email domain allowlist (comma-separated)" "gmail.com" EMAIL_DOMAINS

  # P1-A1: initial Admin
  local_default_bootstrap="admin@${EMAIL_DOMAINS%%,*}"
  prompt "Initial Admin email (P1-A1 bootstrap; blank to skip)" "$local_default_bootstrap" BOOTSTRAP_ADMIN_EMAIL_INPUT
  BOOTSTRAP_ADMIN_EMAIL=""
  if [[ -n "${BOOTSTRAP_ADMIN_EMAIL_INPUT// }" ]]; then
    BOOTSTRAP_ADMIN_EMAIL="$(printf '%s' "$BOOTSTRAP_ADMIN_EMAIL_INPUT" | tr '[:upper:]' '[:lower:]')"
    local bootstrap_domain="${BOOTSTRAP_ADMIN_EMAIL##*@}"
    local matched=false
    IFS=',' read -r -a _allow <<< "$EMAIL_DOMAINS"
    for d in "${_allow[@]}"; do
      d="$(echo "$d" | tr '[:upper:]' '[:lower:]' | xargs)"
      if [[ "$d" == "$bootstrap_domain" ]]; then
        matched=true
        break
      fi
    done
    if [[ "$matched" != "true" ]]; then
      warn "Initial Admin 域名 $bootstrap_domain 不在 ALLOWED_EMAIL_DOMAINS 内；将留空"
      BOOTSTRAP_ADMIN_EMAIL=""
    fi
  fi

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
    "Yes — I have Client ID / Secret (from Google Cloud Console)" \
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
# P1-A1: initial Admin bootstrap (blank => skip; assign via Admin console)
BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_ADMIN_EMAIL:-}
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
echo "  VPS deploy pack:    ./scripts/setup.sh --vps --domain your-domain.com"
echo ""
