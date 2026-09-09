#!/usr/bin/env bash
#
# Deep Research — one-command setup for new clones.
#
# Usage:
#   ./scripts/setup.sh                  # interactive, auto-detects best mode
#   ./scripts/setup.sh --quick          # non-interactive: fake adapter, no API keys, email/password login
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

configure_auth_access() {
  local env_file=".env"
  if [[ "$MODE" == "vps" ]]; then
    env_file="deploy/.env"
  elif [[ "$MODE" == "interactive" ]]; then
    env_file="apps/web/.env"
  fi
  local existing_invite_code
  existing_invite_code="$(read_env_value "$env_file" AUTH_INVITE_CODE)"
  prompt_secret "Password account invite code (blank = generate)" AUTH_INVITE_CODE_INPUT
  AUTH_INVITE_CODE_VAL="${AUTH_INVITE_CODE_INPUT:-${existing_invite_code:-$(gen_secret)}}"
  info "Invite code configured in the generated env file (not printed)"
}

read_env_value() {
  local file="$1" key="$2" value
  [[ -f "$file" ]] || return 0
  value="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
  printf '%s' "$value"
}

load_existing_llm_models() {
  local env_file="${1:-packages/ai-engine/.env}"
  [[ -f "$env_file" ]] || env_file="packages/ai-engine/.env"
  RESEARCH_LLM_VAL="$(read_env_value "$env_file" RESEARCH_LLM)"
  UTILITY_LLM_VAL="$(read_env_value "$env_file" UTILITY_LLM)"
  FALLBACK_LLM_VAL="$(read_env_value "$env_file" FALLBACK_LLM)"
  SMART_LLM_VAL="$(read_env_value "$env_file" SMART_LLM)"
  FAST_LLM_VAL="$(read_env_value "$env_file" FAST_LLM)"
  STRATEGIC_LLM_VAL="$(read_env_value "$env_file" STRATEGIC_LLM)"
  BRIEF_LLM_VAL="$(read_env_value "$env_file" BRIEF_LLM)"
  LLM_FALLBACK_LLM_VAL="$(read_env_value "$env_file" LLM_FALLBACK_LLM)"
  RESEARCH_LLM_VAL="${RESEARCH_LLM_VAL:-$SMART_LLM_VAL}"
  UTILITY_LLM_VAL="${UTILITY_LLM_VAL:-$BRIEF_LLM_VAL}"
  FALLBACK_LLM_VAL="${FALLBACK_LLM_VAL:-$LLM_FALLBACK_LLM_VAL}"
}

load_existing_llm_config() {
  local env_file="${1:-packages/ai-engine/.env}"
  load_existing_llm_models "$env_file"
  ANTHROPIC_KEY="$(read_env_value "$env_file" ANTHROPIC_API_KEY)"
  ANTHROPIC_BASE_URL_VAL="$(read_env_value "$env_file" ANTHROPIC_BASE_URL)"
  OPENAI_KEY="$(read_env_value "$env_file" OPENAI_API_KEY)"
  OPENAI_BASE_URL_VAL="$(read_env_value "$env_file" OPENAI_BASE_URL)"
  MINIMAX_KEY="$(read_env_value "$env_file" MINIMAX_API_KEY)"
  [[ -n "$MINIMAX_KEY" ]] || MINIMAX_KEY="$(read_env_value "$env_file" minimax_api_key)"
  MINIMAX_BASE_URL_VAL="$(read_env_value "$env_file" MINIMAX_BASE_URL)"
  DEEPSEEK_KEY="$(read_env_value "$env_file" DEEPSEEK_API_KEY)"
  [[ -n "$DEEPSEEK_KEY" ]] || DEEPSEEK_KEY="$(read_env_value "$env_file" deepseek_api_key)"
  DEEPSEEK_BASE_URL_VAL="$(read_env_value "$env_file" DEEPSEEK_BASE_URL)"
}

prompt_secret_keep() {
  local question="$1" existing="$2" var_name="$3" answer
  read -rsp "$(echo -e "${CYAN}${question}${NC} (input hidden, Enter to keep existing): ")" answer
  echo ""
  printf -v "$var_name" '%s' "${answer:-$existing}"
}

fetch_llm_models() {
  local base_url="$1" api_key="$2" protocol="$3" response model
  AVAILABLE_MODELS=()
  [[ -n "$base_url" ]] || return 1
  command -v curl >/dev/null 2>&1 || return 1

  local -a headers=(-H "Authorization: Bearer ${api_key:-local-setup}")
  if [[ "$protocol" == "anthropic" ]]; then
    headers+=(-H "x-api-key: ${api_key:-local-setup}" -H "anthropic-version: 2023-06-01")
  fi
  response="$(curl -fsS --max-time 15 "${headers[@]}" "${base_url%/}/models" 2>/dev/null)" || return 1

  if command -v python3 >/dev/null 2>&1; then
    while IFS= read -r model; do
      [[ -n "$model" ]] && AVAILABLE_MODELS+=("$model")
    done < <(printf '%s' "$response" | python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)
    for item in data.get("data", []):
        if isinstance(item, dict) and item.get("id"):
            print(item["id"])
except (ValueError, TypeError, AttributeError):
    pass')
  fi
  [[ "${#AVAILABLE_MODELS[@]}" -gt 0 ]]
}

select_llm_model() {
  local protocol="$1" base_url="$2" api_key="$3" existing_model="$4"
  local model_choice model_input model
  if fetch_llm_models "$base_url" "$api_key" "$protocol"; then
    echo -e "${CYAN}Models returned by ${base_url%/}/models:${NC}"
    local options=()
    local max_models=20
    local index=0
    for model in "${AVAILABLE_MODELS[@]}"; do
      ((index++))
      [[ "$index" -le "$max_models" ]] && options+=("$model")
    done
    options+=("Enter model manually")
    prompt_choice "Choose LLM model:" model_choice "${options[@]}"
    if [[ "$model_choice" =~ ^[0-9]+$ ]] && [[ "$model_choice" -ge 1 ]] && [[ "$model_choice" -le "$(( ${#options[@]} - 1 ))" ]]; then
      SELECTED_LLM_MODEL="${options[$((model_choice - 1))]}"
      return 0
    fi
  else
    warn "Could not read ${base_url%/}/models; enter the model id manually"
  fi
  prompt "LLM model id" "$existing_model" model_input
  SELECTED_LLM_MODEL="$model_input"
  [[ -n "${SELECTED_LLM_MODEL// }" ]]
}

configure_llm_provider() {
  local existing_protocol="2" existing_model="${SMART_LLM_VAL#*:}"
  [[ "${SMART_LLM_VAL%%:*}" == "anthropic" ]] && existing_protocol="1"
  [[ "${SMART_LLM_VAL%%:*}" == "openai" ]] && existing_protocol="2"

  if [[ "$MODE" == "vps" ]]; then
    prompt_choice "Choose LLM provider:" LLM_CHOICE \
      "OpenAI-compatible API (DeepSeek default)" \
      "Anthropic-compatible API" \
      "Fake adapter (no LLM calls — UI walkthrough only)"
  else
    prompt_choice "Choose LLM connection mode:" LLM_CHOICE \
      "Direct provider APIs (MiniMax primary + DeepSeek fallback)" \
      "Local compatible proxy (cc-switch / ais-switch / vibeproxy)" \
      "Fake adapter (no LLM calls — UI walkthrough only)"
  fi

  case "$LLM_CHOICE" in
    1)
      if [[ "$MODE" == "vps" ]]; then
        LLM_PROTOCOL_VAL="openai"
        LLM_BASE_URL_VAL="https://api.deepseek.com/v1"
        prompt "LLM base URL" "$LLM_BASE_URL_VAL" LLM_BASE_URL_VAL
        prompt_secret_keep "DeepSeek API key" "$OPENAI_KEY" OPENAI_KEY
        OPENAI_BASE_URL_VAL="$LLM_BASE_URL_VAL"
        ANTHROPIC_KEY=""; ANTHROPIC_BASE_URL_VAL=""
      else
        ADAPTER_VAL="gpt_researcher"
        MINIMAX_BASE_URL_VAL="${MINIMAX_BASE_URL_VAL:-https://api.minimaxi.com/v1}"
        DEEPSEEK_BASE_URL_VAL="${DEEPSEEK_BASE_URL_VAL:-https://api.deepseek.com/v1}"
        prompt "MiniMax base URL" "$MINIMAX_BASE_URL_VAL" MINIMAX_BASE_URL_VAL
        prompt_secret_keep "MiniMax API key" "$MINIMAX_KEY" MINIMAX_KEY
        prompt "DeepSeek base URL" "$DEEPSEEK_BASE_URL_VAL" DEEPSEEK_BASE_URL_VAL
        prompt_secret_keep "DeepSeek API key" "$DEEPSEEK_KEY" DEEPSEEK_KEY
        RESEARCH_LLM_VAL="minimax:MiniMax-M3"
        UTILITY_LLM_VAL="minimax:MiniMax-M3"
        FALLBACK_LLM_VAL="deepseek:deepseek-v4-flash"
        SMART_LLM_VAL="$RESEARCH_LLM_VAL"
        FAST_LLM_VAL="$RESEARCH_LLM_VAL"
        STRATEGIC_LLM_VAL="$RESEARCH_LLM_VAL"
        BRIEF_LLM_VAL="$UTILITY_LLM_VAL"
        return 0
      fi
      ;;
    2)
      if [[ "$MODE" == "vps" ]]; then
        LLM_PROTOCOL_VAL="anthropic"
        LLM_BASE_URL_VAL="https://api.anthropic.com/v1"
        prompt "LLM base URL" "$LLM_BASE_URL_VAL" LLM_BASE_URL_VAL
        prompt_secret_keep "Anthropic API key" "$ANTHROPIC_KEY" ANTHROPIC_KEY
        ANTHROPIC_BASE_URL_VAL="$LLM_BASE_URL_VAL"
        OPENAI_KEY=""; OPENAI_BASE_URL_VAL=""
      else
        prompt_choice "Choose local proxy protocol:" PROXY_PROTOCOL_CHOICE \
          "Anthropic-compatible (cc-switch, default port 15721)" \
          "OpenAI-compatible (ais-switch / vibeproxy)"
        if [[ "$PROXY_PROTOCOL_CHOICE" == "1" ]]; then
          LLM_PROTOCOL_VAL="anthropic"
          LLM_BASE_URL_VAL="${ANTHROPIC_BASE_URL_VAL:-http://localhost:15721}"
          prompt "Proxy base URL" "$LLM_BASE_URL_VAL" LLM_BASE_URL_VAL
          prompt_secret_keep "Proxy API key" "$ANTHROPIC_KEY" ANTHROPIC_KEY
          ANTHROPIC_BASE_URL_VAL="$LLM_BASE_URL_VAL"
          OPENAI_KEY=""; OPENAI_BASE_URL_VAL=""
        else
          LLM_PROTOCOL_VAL="openai"
          LLM_BASE_URL_VAL="${OPENAI_BASE_URL_VAL:-http://localhost:8318/v1}"
          prompt "Proxy base URL" "$LLM_BASE_URL_VAL" LLM_BASE_URL_VAL
          prompt_secret_keep "Proxy API key" "$OPENAI_KEY" OPENAI_KEY
          OPENAI_BASE_URL_VAL="$LLM_BASE_URL_VAL"
          ANTHROPIC_KEY=""; ANTHROPIC_BASE_URL_VAL=""
        fi
      fi
      ;;
    3)
      ANTHROPIC_KEY=""; ANTHROPIC_BASE_URL_VAL=""
      OPENAI_KEY=""; OPENAI_BASE_URL_VAL=""
      ADAPTER_VAL="fake"
      RESEARCH_LLM_VAL="anthropic:deepseek-v4-flash"
      UTILITY_LLM_VAL="$RESEARCH_LLM_VAL"
      SMART_LLM_VAL="$RESEARCH_LLM_VAL"
      FAST_LLM_VAL="$RESEARCH_LLM_VAL"
      STRATEGIC_LLM_VAL="$RESEARCH_LLM_VAL"
      BRIEF_LLM_VAL="$UTILITY_LLM_VAL"
      FALLBACK_LLM_VAL=""
      return 0
      ;;
  esac

  ADAPTER_VAL="gpt_researcher"
  select_llm_model "$LLM_PROTOCOL_VAL" "$LLM_BASE_URL_VAL" "${ANTHROPIC_KEY:-$OPENAI_KEY}" "$existing_model" \
    || fail "No LLM model selected"
  RESEARCH_LLM_VAL="${LLM_PROTOCOL_VAL}:${SELECTED_LLM_MODEL}"
  UTILITY_LLM_VAL="$RESEARCH_LLM_VAL"
  SMART_LLM_VAL="$RESEARCH_LLM_VAL"
  FAST_LLM_VAL="$RESEARCH_LLM_VAL"
  STRATEGIC_LLM_VAL="$RESEARCH_LLM_VAL"
  BRIEF_LLM_VAL="$UTILITY_LLM_VAL"
  FALLBACK_LLM_VAL="${LLM_FALLBACK_LLM_VAL:-}"
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

  if [[ "$MODE" == "vps" ]]; then
    load_existing_llm_config "deploy/.env"
  else
    load_existing_llm_config ".env"
  fi

  prompt "Deploy URL (for NextAuth callback)" "$deploy_url_default" DEPLOY_URL
  prompt "Email domain allowlist (comma-separated)" "gmail.com,shopee.com" EMAIL_DOMAINS
  validate_non_empty "$EMAIL_DOMAINS" "ALLOWED_EMAIL_DOMAINS"
  configure_auth_access

  # P1-A1: collect initial Admin email (must belong to allowlist).
  local default_bootstrap="shaobo.chen@shopee.com"
  prompt "Initial Admin email (type off to disable bootstrap)" "$default_bootstrap" BOOTSTRAP_ADMIN_EMAIL_INPUT
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

  configure_llm_provider

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

  prompt_choice "Configure optional Google OAuth login?" OAUTH_CHOICE \
    "Yes — I have Client ID / Secret (from Google Cloud Console)" \
    "Skip (use email/password login only)"

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
AUTH_INVITE_CODE=${AUTH_INVITE_CODE_VAL}

# LLM
AI_ENGINE_ADAPTER=${ADAPTER_VAL}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL_VAL}
OPENAI_API_KEY=${OPENAI_KEY}
OPENAI_BASE_URL=${OPENAI_BASE_URL_VAL}
MINIMAX_API_KEY=${MINIMAX_KEY}
MINIMAX_BASE_URL=${MINIMAX_BASE_URL_VAL}
DEEPSEEK_API_KEY=${DEEPSEEK_KEY}
DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL_VAL}
RESEARCH_LLM=${RESEARCH_LLM_VAL}
UTILITY_LLM=${UTILITY_LLM_VAL}
FALLBACK_LLM=${FALLBACK_LLM_VAL}
# Legacy mirrors; runtime resolution prefers RESEARCH/UTILITY/FALLBACK.
SMART_LLM=${SMART_LLM_VAL}
FAST_LLM=${FAST_LLM_VAL}
STRATEGIC_LLM=${STRATEGIC_LLM_VAL}
BRIEF_LLM=${BRIEF_LLM_VAL}
LLM_FALLBACK_LLM=${FALLBACK_LLM_VAL:-${LLM_FALLBACK_LLM_VAL:-}}

# Search
TAVILY_API_KEY=${TAVILY_KEY}
RETRIEVER=${RETRIEVER_VAL}

# Google OAuth
GOOGLE_CLIENT_ID=${GOOGLE_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}

# Optional radar tokens
GH_TOKEN=${GH_TOKEN_VAL}
PRODUCTHUNT_API_TOKEN=${PH_TOKEN_VAL}

# P1-A1: initial Admin bootstrap
BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_ADMIN_EMAIL:-shaobo.chen@shopee.com}
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
  echo "  1) Quick  — fake adapter, zero keys, email/password login"
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
    echo -e "  ${YELLOW}Google OAuth: not configured.${NC} (email/password login remains available)"
    echo "  To enable, get credentials at https://console.cloud.google.com/apis/credentials"
    echo "  Callback URL: ${DEPLOY_URL}/api/auth/callback/google"
  fi
  echo ""
  echo -e "  Initial Admin: ${BOOTSTRAP_ADMIN_EMAIL:-shaobo.chen@shopee.com}"
  echo "  First login: choose invite-code activation and set the Admin password once."
  echo "  Invite code: stored in deploy/.env as AUTH_INVITE_CODE (not printed by setup)."
  echo "  Admin console: ${DEPLOY_URL}/admin"

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

  # Containers reach host-side proxies through host.docker.internal.
  if [[ "$LLM_BASE_URL_VAL" == http://localhost:* || "$LLM_BASE_URL_VAL" == http://127.0.0.1:* ]]; then
    LLM_BASE_URL_VAL="$(printf '%s' "$LLM_BASE_URL_VAL" | sed 's#^http://localhost:#http://host.docker.internal:#; s#^http://127.0.0.1:#http://host.docker.internal:#')"
    if [[ "$LLM_PROTOCOL_VAL" == "anthropic" ]]; then
      ANTHROPIC_BASE_URL_VAL="$LLM_BASE_URL_VAL"
    else
      OPENAI_BASE_URL_VAL="$LLM_BASE_URL_VAL"
    fi
    info "Docker will reach the host proxy at ${LLM_BASE_URL_VAL}"
  fi

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

  if DATABASE_URL="postgresql://postgres:${PG_PASS}@localhost:5432/deep_research" pnpm db:deploy; then
    info "Migrations applied"
  else
    fail "Migration failed. Run inside container: docker compose -f infra/docker-compose.yml exec web pnpm db:deploy"
  fi

  step "Ensuring initial Admin"
  if docker compose -f infra/docker-compose.yml exec -T web \
    /repo/node_modules/.bin/tsx /repo/apps/web/scripts/bootstrap-admin.ts; then
    info "Initial Admin ensured"
  else
    warn "Could not bootstrap the initial Admin; inspect web logs and ALLOWED_EMAIL_DOMAINS"
  fi

  step "Ensuring default radar sources"
  if docker compose -f infra/docker-compose.yml exec -T web \
    /repo/node_modules/.bin/tsx /repo/apps/web/scripts/bootstrap-radar-sources.ts; then
    info "Default radar sources ensured"
  else
    warn "Could not seed default radar sources; inspect web logs before using the Radar"
  fi

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
    echo -e "  Public pages work without login; AI research, comments, follows, bookmarks, personal content, and admin require login."
    echo -e "  AI research uses mock data, no API costs."
  fi
  if [[ -z "$GOOGLE_ID" ]]; then
    echo -e "  ${YELLOW}Google OAuth: not configured${NC} (use email/password login)"
  fi
  echo ""
  echo -e "  Initial Admin: ${BOOTSTRAP_ADMIN_EMAIL:-shaobo.chen@shopee.com}"
  echo "  First login: choose invite-code activation and set the Admin password once."
  echo "  Invite code: stored in .env as AUTH_INVITE_CODE (not printed by setup)."
  echo "  Admin console: ${DEPLOY_URL}/admin"

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
command -v uv      >/dev/null 2>&1 || fail "uv not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
command -v psql    >/dev/null 2>&1 || warn "psql not found — PostgreSQL client tools recommended"

PY_BIN="${PYTHON_BIN:-}"
if [[ -z "$PY_BIN" ]]; then
  for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PY_BIN="$candidate"
      break
    fi
  done
fi
[[ -n "$PY_BIN" ]] || fail "Python 3 not found. Install Python >= 3.11 (https://python.org/)"

PYVER=$("$PY_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PYVER_OK=$("$PY_BIN" -c 'import sys; print(1 if sys.version_info >= (3,11) else 0)')
[[ "$PYVER_OK" == "1" ]] || fail "Python $PYVER found, need >= 3.11"

NODEVER=$(node -v | sed 's/v//' | cut -d. -f1)
[[ "$NODEVER" -ge 20 ]] || fail "Node.js $NODEVER found, need >= 20"

info "All prerequisites satisfied"

GH_TOKEN_VAL=""
PH_TOKEN_VAL=""
AUTH_INVITE_CODE_VAL=""

if [[ "$MODE" != "quick" ]]; then
  step "Configuration"

  load_existing_llm_config "packages/ai-engine/.env"

  prompt "PostgreSQL host" "localhost" PG_HOST
  prompt "PostgreSQL port" "5432" PG_PORT
  prompt "PostgreSQL user" "postgres" PG_USER
  prompt_secret "PostgreSQL password" PG_PASS_INPUT
  PG_PASS="${PG_PASS_INPUT:-postgres}"

  prompt "Email domain allowlist (comma-separated)" "gmail.com,shopee.com" EMAIL_DOMAINS

  # P1-A1: initial Admin
  configure_auth_access

  local_default_bootstrap="shaobo.chen@shopee.com"
  prompt "Initial Admin email (type off to disable bootstrap)" "$local_default_bootstrap" BOOTSTRAP_ADMIN_EMAIL_INPUT
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

  configure_llm_provider

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

  prompt_choice "Configure optional Google OAuth login?" OAUTH_CHOICE \
    "Yes — I have Client ID / Secret (from Google Cloud Console)" \
    "Skip (use email/password login only)"

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
  PG_HOST="${PG_HOST:-localhost}"; PG_PORT="${PG_PORT:-5432}"; PG_USER="${PG_USER:-postgres}"; PG_PASS="${PG_PASS:-postgres}"
  EMAIL_DOMAINS="gmail.com,shopee.com"
  AUTH_INVITE_CODE_VAL="quick-local-invite"
  BOOTSTRAP_ADMIN_EMAIL="shaobo.chen@shopee.com"
  ANTHROPIC_KEY=""; ANTHROPIC_BASE_URL_VAL=""; OPENAI_KEY=""; OPENAI_BASE_URL_VAL=""; ADAPTER_VAL="fake"
  MINIMAX_KEY=""; MINIMAX_BASE_URL_VAL=""; DEEPSEEK_KEY=""; DEEPSEEK_BASE_URL_VAL=""
  FALLBACK_LLM_VAL=""
  TAVILY_KEY=""; RETRIEVER_VAL="tavily"
  GOOGLE_ID=""; GOOGLE_SECRET=""
  load_existing_llm_config "packages/ai-engine/.env"
  SMART_LLM_VAL="anthropic:deepseek-v4-flash"; FAST_LLM_VAL="$SMART_LLM_VAL"; STRATEGIC_LLM_VAL="$SMART_LLM_VAL"; BRIEF_LLM_VAL="$SMART_LLM_VAL"
fi

step "Installing JS dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
info "JS dependencies installed"

step "Setting up Python environment"
cd packages/ai-engine
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/deep-research-uv-cache}" uv sync
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
AUTH_INVITE_CODE=${AUTH_INVITE_CODE_VAL}
MAX_UPLOAD_SIZE_MB=5
TIME_VALUE_USD_PER_HOUR=50
# P1-A1: initial Admin bootstrap
BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_ADMIN_EMAIL:-shaobo.chen@shopee.com}
WEBENV
info "apps/web/.env created"

cat > packages/ai-engine/.env << AIENV
# Auto-generated by scripts/setup.sh
DATABASE_URL=${DB_URL}
AI_ENGINE_ADAPTER=${ADAPTER_VAL}
TAVILY_API_KEY=${TAVILY_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL_VAL}
OPENAI_API_KEY=${OPENAI_KEY}
OPENAI_BASE_URL=${OPENAI_BASE_URL_VAL}
MINIMAX_API_KEY=${MINIMAX_KEY}
MINIMAX_BASE_URL=${MINIMAX_BASE_URL_VAL}
DEEPSEEK_API_KEY=${DEEPSEEK_KEY}
DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL_VAL}
RESEARCH_LLM=${RESEARCH_LLM_VAL}
UTILITY_LLM=${UTILITY_LLM_VAL}
FALLBACK_LLM=${FALLBACK_LLM_VAL}
# Legacy mirrors; runtime resolution prefers RESEARCH/UTILITY/FALLBACK.
SMART_LLM=${SMART_LLM_VAL}
FAST_LLM=${FAST_LLM_VAL}
STRATEGIC_LLM=${STRATEGIC_LLM_VAL}
BRIEF_LLM=${BRIEF_LLM_VAL}
LLM_FALLBACK_LLM=${FALLBACK_LLM_VAL:-${LLM_FALLBACK_LLM_VAL:-}}
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
  DATABASE_URL="$DB_URL" pnpm db:deploy || fail "Migration failed — check DATABASE_URL in apps/web/.env"
  info "Migrations applied"
  DATABASE_URL="$DB_URL" pnpm db:generate && info "Prisma client generated" || true
  step "Ensuring initial Admin"
  BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-shaobo.chen@shopee.com}" \
    ALLOWED_EMAIL_DOMAINS="$EMAIL_DOMAINS" \
    DATABASE_URL="$DB_URL" \
    pnpm --filter @deep-research/web bootstrap:admin \
    || fail "Initial Admin bootstrap failed — check ALLOWED_EMAIL_DOMAINS and BOOTSTRAP_ADMIN_EMAIL"
  info "Initial Admin ensured"
  step "Ensuring default radar sources"
  DATABASE_URL="$DB_URL" pnpm --filter @deep-research/web bootstrap:radar \
    || fail "Default radar source bootstrap failed"
  info "Default radar sources ensured"
else
  fail "PostgreSQL not detected at ${PG_HOST}:${PG_PORT} — start PostgreSQL, then rerun ./scripts/setup.sh"
fi

echo ""
echo -e "${BOLD}${GREEN}Setup complete!${NC}"
echo ""
if [[ "$ADAPTER_VAL" == "fake" ]]; then
  echo -e "  ${YELLOW}Fake adapter${NC} — AI research returns mock data."
  echo -e "  Public pages work without login; AI research, comments, follows, bookmarks, personal content, and admin require login."
  echo -e "  AI research uses mock data, no API costs."
else
  if [[ "$LLM_PROTOCOL_VAL" == "openai" && -z "$OPENAI_KEY" ]]; then
    echo -e "  ${YELLOW}⚠  OPENAI_API_KEY is empty${NC} — edit packages/ai-engine/.env to enable real LLM"
  elif [[ "$LLM_PROTOCOL_VAL" == "anthropic" && -z "$ANTHROPIC_KEY" ]]; then
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
echo -e "${BOLD}Initial Admin:${NC} ${BOOTSTRAP_ADMIN_EMAIL:-shaobo.chen@shopee.com}"
echo "First login: choose invite-code activation and set the Admin password once."
echo "Invite code: stored in apps/web/.env as AUTH_INVITE_CODE (not printed by setup)."
echo "Admin console: http://localhost:3000/admin"
echo ""
if [[ -z "$GOOGLE_ID" ]]; then
  echo "  Google OAuth: not configured (email/password login is available)"
  echo "  To enable: https://console.cloud.google.com/apis/credentials"
  echo "  Callback: http://localhost:3000/api/auth/callback/google"
fi
echo ""
echo "  Docker alternative: ./scripts/setup.sh --docker"
echo "  VPS deploy pack:    ./scripts/setup.sh --vps --domain your-domain.com"
echo ""
