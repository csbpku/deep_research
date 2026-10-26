#!/usr/bin/env bash
# Install the Playwright browser system dependencies from a cached apt
# archive.
#
# Why this exists
# ---------------
# `playwright install --with-deps` runs `apt-get update` followed by
# `apt-get install -y --no-install-recommends <packages>`. On the GitHub
# runner image that download is roughly 26 MB, most of it CJK and Japanese
# fonts. When several CI jobs install those packages at the same time the
# Ubuntu mirror throttles the download to a few tens of kB/s: on
# 2026-10-23 the web E2E job spent 11m12s in that step and was then killed
# by the job timeout, even though the E2E suite had only been running for
# three minutes.
#
# This script installs the packages into a dedicated apt archive directory
# instead of the default one. The directory is persisted with `actions/cache`,
# so a run that finds the cache installs everything without downloading a
# single byte. The mirror can then no longer decide how long CI takes.
#
# The package list is not hard-coded. It is derived from the Playwright
# version that is installed in the workspace, so it cannot drift away from
# the browser build that is actually going to run.
#
# Usage:
#   scripts/install-playwright-deps.sh                  # install
#   scripts/install-playwright-deps.sh --print-packages # list only
#   scripts/install-playwright-deps.sh --cache-suffix   # print the cache key
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# A dedicated archive directory. It deliberately does not live under
# /var/cache/apt/archives, because the runner image removes the .deb files
# from that directory after every install.
APT_ARCHIVE_DIR="${APT_ARCHIVE_DIR:-/var/cache/apt/playwright}"
APT_KEEP_CONFIG="${APT_KEEP_CONFIG:-/etc/apt/apt.conf.d/99keep-playwright-cache}"

mode="install"
case "${1:-}" in
  "") ;;
  --print-packages) mode="print" ;;
  --cache-suffix) mode="suffix" ;;
  *)
    echo "Usage: $0 [--print-packages|--cache-suffix]" >&2
    exit 2
    ;;
esac

sudo_cmd=()
if [ "$(id -u)" -ne 0 ]; then
  sudo_cmd=(sudo)
fi

# The cache key has to change whenever the installed browser build or the
# distribution changes, otherwise a stale archive could be reused for a
# package set that no longer matches the package index.
distro_version() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    ( . /etc/os-release && printf '%s' "${VERSION_ID:-unknown}" )
  else
    printf '%s' "unknown"
  fi
}

playwright_version() {
  local manifest="apps/web/node_modules/@playwright/test/package.json"
  if [ -r "$manifest" ]; then
    node -e "console.log(require('./$manifest').version)"
  else
    echo "The Playwright package is not installed; run 'pnpm install' first." >&2
    exit 2
  fi
}

cache_suffix() {
  printf '%s-%s' "$(distro_version)" "$(playwright_version)"
}

if [ "$mode" = "suffix" ]; then
  cache_suffix
  exit 0
fi

# Read the package list straight out of the installed Playwright, so it
# always matches the browser build that is going to run. The list is the
# entry for the platform that actually runs, so the package names are the
# ones that exist on that release.
packages=()
while IFS= read -r package; do
  [ -n "$package" ] || continue
  packages+=("$package")
done < <(node "$repo_root/scripts/playwright-deps-packages.mjs")

if [ "${#packages[@]}" -eq 0 ]; then
  echo "Could not determine the Playwright system dependencies." >&2
  exit 1
fi

if [ "$mode" = "print" ]; then
  printf '%s\n' "${packages[@]}"
  exit 0
fi

echo "Installing ${#packages[@]} Playwright system packages into ${APT_ARCHIVE_DIR}:"
printf '  %s\n' "${packages[@]}"

"${sudo_cmd[@]}" mkdir -p "$APT_ARCHIVE_DIR"

# Keep the downloaded .deb files. apt removes them after a successful
# install unless this is turned off.
"${sudo_cmd[@]}" mkdir -p "$(dirname "$APT_KEEP_CONFIG")"
printf 'binary::apt::APT::Keep-Downloaded-Packages "true";\n' \
  | "${sudo_cmd[@]}" tee "$APT_KEEP_CONFIG" > /dev/null

apt_options=(
  -y
  --no-install-recommends
  -o "Dir::Cache::archives=${APT_ARCHIVE_DIR}"
)

"${sudo_cmd[@]}" apt-get update

# Prefer the cached archive: with --no-download apt fails fast instead of
# waiting for a throttled mirror. If a package is genuinely missing from
# the cache, fall back to a normal install so the run can still succeed.
if ! "${sudo_cmd[@]}" apt-get install "${apt_options[@]}" --no-download "${packages[@]}"; then
  echo "The cached apt archive is incomplete; downloading the missing packages." >&2
  "${sudo_cmd[@]}" apt-get install "${apt_options[@]}" "${packages[@]}"
fi

echo "Playwright system dependencies installed."

# apt leaves two entries behind that the CI cache cannot archive: the lock
# file and the `partial` directory it downloads into. Both are owned by
# root and are not readable by the user that runs `actions/cache`, so the
# tar step fails with "Cannot open: Permission denied" and the archive is
# never saved. Without this the cache misses on every run and the Ubuntu
# mirror keeps deciding how long the E2E jobs take.
#
# Removing them also keeps the archive limited to the .deb files, which is
# all the cache is for.
"${sudo_cmd[@]}" rm -rf "${APT_ARCHIVE_DIR}/lock" "${APT_ARCHIVE_DIR}/partial"

# The archive is written by apt as root. The cache step reads it as the
# runner user, so the files have to be readable by everyone.
"${sudo_cmd[@]}" chmod -R a+rX "$APT_ARCHIVE_DIR"
