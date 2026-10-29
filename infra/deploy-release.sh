#!/usr/bin/env bash
# Run only from a verified, staged release; the caller serializes production changes.
set -Eeuo pipefail

cd "$DEPLOY_PATH"
: "${CANDIDATE_INFRA:?staged deployment files are required}"
: "${IMAGE_TAG:?tested source SHA is required}"
test -f .env
test -f infra/docker-compose.registry.yml
test "$(stat -c '%u' .env)" = "$(id -u)" || {
  echo "The deployment account must own .env to update Reader Beta metadata without changing file ownership" >&2
  exit 1
}

backup_dir="$(mktemp -d "$DEPLOY_PATH/.releases/rollback-${IMAGE_TAG}.XXXXXX")"
beta_env_backup="$backup_dir/.env"
mkdir -p "$backup_dir/infra"
files=()
while IFS= read -r file; do
  [[ "$file" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid deployment filename" >&2; exit 1; }
  test -f "$CANDIDATE_INFRA/$file"
  files+=("$file")
  if [ -e "infra/$file" ]; then cp -p "infra/$file" "$backup_dir/infra/$file"; fi
done < "$CANDIDATE_INFRA/deploy-files.txt"
config_updated=0
cp -p .env "$beta_env_backup"
chmod 600 "$beta_env_backup"
beta_env_updated=0

set_env_value() {
  local key="$1" value="$2" tmp mode
  tmp="$(mktemp "$DEPLOY_PATH/.env.reader-beta-write.XXXXXX")"
  mode="$(stat -c '%a' .env)"
  if ! awk -v key="$key" -v value="$value" '
    BEGIN { prefix = key "="; found = 0 }
    index($0, prefix) == 1 {
      if (!found) print prefix value
      found = 1
      next
    }
    { print }
    END { if (!found) print prefix value }
  ' .env > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chgrp --reference=.env "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" .env
}

remove_env_value() {
  local key="$1" tmp
  tmp="$(mktemp "$DEPLOY_PATH/.env.reader-beta-write.XXXXXX")"
  if ! awk -v key="$key" 'index($0, key "=") != 1 { print }' .env > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chgrp --reference=.env "$tmp"
  chmod "$(stat -c '%a' .env)" "$tmp"
  mv -f "$tmp" .env
}

restore_release_env() {
  local key value
  for key in READING_EXTENSION_BETA_URL READING_EXTENSION_BETA_PATH READING_EXTENSION_BETA_VERSION READING_EXTENSION_BETA_SHA256 WEB_IMAGE AI_ENGINE_IMAGE; do
    if grep -q "^${key}=" "$beta_env_backup"; then
      value="$(awk -v key="$key" 'index($0, key "=") == 1 { sub("^[^=]*=", ""); print; exit }' "$beta_env_backup")"
      set_env_value "$key" "$value"
    else
      remove_env_value "$key"
    fi
  done
}

compose=(docker compose
  --env-file .env
  -f infra/docker-compose.yml
  -f infra/docker-compose.registry.yml)
previous_tag="$(cat .deployed-image-tag 2>/dev/null || true)"
# A verified workspace release can replace the registry images without
# changing that marker. Roll back to what was actually running.
previous_web_image="$(docker inspect --format '{{.Config.Image}}' deep-research-web-1 2>/dev/null || true)"
previous_ai_image="$(docker inspect --format '{{.Config.Image}}' deep-research-ai-engine-1 2>/dev/null || true)"
previous_repair_image="$(docker inspect --format '{{.Config.Image}}' deep-research-repair-repair-1 2>/dev/null || true)"
if [ -z "$previous_web_image" ] && [ -z "$previous_ai_image" ] && [[ "$previous_tag" =~ ^[0-9a-f]{40}$ ]]; then
  previous_web_image="ghcr.io/csbpku/deep-research/web:$previous_tag"
  previous_ai_image="ghcr.io/csbpku/deep-research/ai-engine:$previous_tag"
fi

# rollback [exit_status]: also called explicitly where `exit 1` would
# otherwise bypass the ERR trap (exit never fires ERR).
rollback() {
  status=${1:-$?}
  [ "$status" -ne 0 ] || status=1
  trap - ERR
  set +e
  echo "[deploy] release failed; restoring previous release config and attempting image rollback" >&2
  if [ "$beta_env_updated" -eq 1 ]; then restore_release_env || echo "[deploy] environment rollback failed" >&2; fi
  if [ "$config_updated" -eq 1 ]; then
    for file in "${files[@]}"; do
      if [ -f "$backup_dir/infra/$file" ]; then
        cp -p "$backup_dir/infra/$file" "infra/$file" || echo "[deploy] configuration rollback failed: $file" >&2
      else
        rm -f -- "infra/$file"
      fi
    done
  fi
  if [ -n "$previous_web_image" ] && [ -n "$previous_ai_image" ]; then
    export WEB_IMAGE="$previous_web_image"
    export AI_ENGINE_IMAGE="$previous_ai_image"
    for image in "$WEB_IMAGE" "$AI_ENGINE_IMAGE"; do
      if ! docker image inspect "$image" >/dev/null 2>&1; then
        timeout --signal=TERM --kill-after=30s 10m docker pull "$image" || true
      fi
    done
    timeout --signal=TERM --kill-after=30s 5m \
      "${compose[@]}" up -d --no-build --pull never || true
    "${compose[@]}" exec -T nginx nginx -s reload </dev/null || true
    if [ -f .radar-repair-enabled ] && [ -n "$previous_repair_image" ]; then
      AI_ENGINE_IMAGE="$previous_repair_image" docker compose --env-file .env -f infra/docker-compose.radar-repair.yml up -d --no-build || true
    fi
    for endpoint in healthz readyz ai-healthz; do
      if ! curl --noproxy '*' --http1.1 --fail --silent --show-error --max-time 10 --resolve techradar.top:443:127.0.0.1 "https://techradar.top/$endpoint" >/dev/null; then
        echo "[deploy] rollback health check failed: $endpoint" >&2
      fi
    done
  else
    echo "[deploy] no complete previous image pair; skipping image rollback" >&2
  fi
  "${compose[@]}" ps || true
  echo "[deploy] retained configuration backup: $beta_env_backup"
  exit "$status"
}
trap rollback ERR

config_updated=1
for file in "${files[@]}"; do cp -p "$CANDIDATE_INFRA/$file" "infra/$file"; done
beta_env_updated=1
set_env_value READING_EXTENSION_BETA_URL "$READER_BETA_URL"
set_env_value READING_EXTENSION_BETA_PATH ""
set_env_value READING_EXTENSION_BETA_VERSION "$READER_BETA_VERSION"
set_env_value READING_EXTENSION_BETA_SHA256 "$READER_BETA_SHA256"

echo "[deploy] validating compose configuration"
"${compose[@]}" config --quiet
# Pre-migration safety dump: the web entrypoint applies Prisma migrations
# on start, which are not automatically reversible. Skip only when the
# postgres container is not running yet (first deploy). A failed dump
# aborts the release (ERR trap -> rollback) before any service changes.
if "${compose[@]}" ps --status running --services 2>/dev/null | grep -qx postgres; then
  mkdir -p infra/backups
  predeploy_dump="infra/backups/pre-deploy-${IMAGE_TAG}-$(date +%Y%m%d-%H%M%S).sql.gz"
  echo "[deploy] writing pre-migration dump $predeploy_dump"
  if ! ( umask 077
         "${compose[@]}" exec -T postgres pg_dump -U postgres -d deep_research \
           --clean --if-exists --no-owner --no-privileges </dev/null \
           | gzip > "$predeploy_dump" ); then
    echo "[deploy] retained incomplete dump for diagnosis (do not restore): $predeploy_dump" >&2
    echo "[deploy] pre-migration pg_dump failed; aborting release" >&2
    rollback 1
  fi
  # Retention is explicit maintenance; deploy never removes backups.
else
  echo "[deploy] postgres not running; skipping pre-migration dump"
fi
echo "[deploy] pulling $IMAGE_TAG"
pull_one_image() {
  local service="$1"
  local attempt
  for attempt in 1 2 3; do
    echo "[deploy] pulling $service (attempt $attempt/3; 15 minute limit)"
    if timeout --signal=TERM --kill-after=30s 15m \
      "${compose[@]}" pull "$service"; then
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      echo "[deploy] $service pull failed or timed out; retrying in 15 seconds" >&2
      sleep 15
    fi
  done
  return 1
}
pull_log_dir="$backup_dir/pull-logs"
mkdir -p "$pull_log_dir"
pull_one_image web >"$pull_log_dir/web.log" 2>&1 &
web_pull_pid=$!
pull_one_image ai-engine >"$pull_log_dir/ai-engine.log" 2>&1 &
ai_pull_pid=$!

pull_failed=0
if ! wait "$web_pull_pid"; then pull_failed=1; fi
if ! wait "$ai_pull_pid"; then pull_failed=1; fi
for service in web ai-engine; do
  echo "[deploy] $service pull log"
  cat "$pull_log_dir/$service.log"
done
if [ "$pull_failed" -ne 0 ]; then
  echo "[deploy] one or more image pulls failed" >&2
  rollback 1
fi
echo "[deploy] starting services; web entrypoint will apply migrations"
# Retain independent/one-off verification containers. Cleanup is
# explicit maintenance, just like database backup retention.
"${compose[@]}" up -d --no-build
# Nginx resolves Compose service names at startup. Re-resolve them
# after image replacement changes the web/AI container addresses.
"${compose[@]}" exec -T nginx nginx -t </dev/null
"${compose[@]}" exec -T nginx nginx -s reload </dev/null
echo "[deploy] waiting for public health endpoints"
wait_for_endpoint() {
  local label="$1"
  local url="$2"
  local attempt
  for attempt in $(seq 1 40); do
    if curl --noproxy '*' --http1.1 --fail --silent --show-error --max-time 10 \
      --resolve techradar.top:443:127.0.0.1 "$url" >/dev/null; then
      echo "[deploy] $label is healthy (attempt $attempt/40)"
      return 0
    fi
    echo "[deploy] $label not ready (attempt $attempt/40); retrying in 3 seconds" >&2
    sleep 3
  done
  echo "[deploy] $label did not become healthy within 120 seconds" >&2
  return 1
}
wait_for_endpoint web https://techradar.top/healthz
wait_for_endpoint web-ready https://techradar.top/readyz
wait_for_endpoint ai https://techradar.top/ai-healthz
for path in /ai/docs /ai/openapi.json /ai/api/ai/jobs; do
  status="$(curl --noproxy '*' --http1.1 --silent --show-error --max-time 10 \
    --resolve techradar.top:443:127.0.0.1 \
    -o /dev/null -w '%{http_code}' "https://techradar.top$path")"
  test "$status" = 404 || {
    echo "[deploy] public $path returned $status instead of 404" >&2
    rollback 1
  }
done
# Independent worker follows formal images once explicitly enabled.
if [ -f .radar-repair-enabled ]; then
  docker compose --env-file .env -f infra/docker-compose.radar-repair.yml up -d --no-build
fi
# Persist the verified images as well as the marker. Source-snapshot
# selectors in .env must not undo this release on the next compose up.
set_env_value WEB_IMAGE "$WEB_IMAGE"
set_env_value AI_ENGINE_IMAGE "$AI_ENGINE_IMAGE"
"${compose[@]}" ps
marker_tmp="$(mktemp "$DEPLOY_PATH/.deployed-image-tag.XXXXXX")"
printf '%s\n' "$IMAGE_TAG" > "$marker_tmp"
mv -f "$marker_tmp" .deployed-image-tag
echo "[deploy] retained configuration backup: $beta_env_backup"
trap - ERR
echo "[deploy] release $IMAGE_TAG is healthy"
