#!/usr/bin/env bash
set -euo pipefail

# Renew certificates in the same Docker volume used by nginx, then reload the
# reverse proxy so it starts serving the renewed certificate immediately.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

compose=(
  docker compose
  --env-file .env
  -f infra/docker-compose.yml
  -f infra/docker-compose.certbot.yml
)
"${compose[@]}" --profile certbot run --rm certbot \
  renew \
  --webroot \
  --webroot-path /var/www/certbot \
  --quiet

"${compose[@]}" exec -T nginx nginx -s reload
