#!/usr/bin/env bash
# Classify a change set.
#
# Usage (from inside the git work tree that holds the change):
#   scripts/ci-changed-paths.sh <base-sha> <head-sha>
#   scripts/ci-changed-paths.sh --list <base-sha> <head-sha>
#   scripts/ci-changed-paths.sh --scope <base-sha> <head-sha>
#
# Exit codes:
#   0  documentation-only  -> the heavy CI jobs and the release pipeline
#                             can be skipped
#   1  deployable change   -> run everything
#   2  usage or git error
#
# The rule is intentionally conservative: anything that is not clearly a
# documentation path resolves to "deployable", so an unrecognised change can
# never be silently skipped.
#
# `--scope` prints the classification instead of the exit code:
#   documentation  -> only Markdown and docs/ changed
#   ci-only        -> only CI and release tooling changed; the heavy CI
#                     suites still have to run, but no image and no
#                     extension package changed, so there is nothing to
#                     deploy
#   deployable     -> everything else
set -euo pipefail

# Markdown that ships inside a build artefact is not documentation: the Beta
# bundle copies these files verbatim into the extension zip. Changing them
# changes the artefact, so they must trigger a release like any other source
# change.
#
# The list is derived from the packaging script itself so a newly bundled
# Markdown file cannot slip through as "documentation". The hard-coded list is
# kept as a fallback in case the script changes shape.
BETA_PACKAGE_SCRIPT="apps/extension/scripts/package-beta.mjs"
ARTEFACT_MARKDOWN_FALLBACK=(
  "apps/extension/BETA_CHECKLIST.md"
  "apps/extension/BETA_INSTALL.md"
  "apps/extension/COMPATIBILITY.md"
  "apps/extension/PRIVACY.md"
)

usage() {
  echo "Usage: $0 [--list|--scope] <base-sha> <head-sha>" >&2
  exit 2
}

list_only=false
scope_only=false
if [ "${1:-}" = "--list" ]; then
  list_only=true
  shift
elif [ "${1:-}" = "--scope" ]; then
  scope_only=true
  shift
fi

[ "$#" -eq 2 ] || usage
base="$1"
head="$2"

if ! toplevel="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Not inside a git work tree." >&2
  exit 2
fi
cd "$toplevel"

# Derive the artefact Markdown list from the packaging script so it cannot
# drift away from what actually ends up in the Beta zip. The script lists the
# copied files as quoted names in one array literal.
ARTEFACT_MARKDOWN=()
if [ -f "$BETA_PACKAGE_SCRIPT" ]; then
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    ARTEFACT_MARKDOWN+=("apps/extension/$name")
  done < <(
    sed -n "s/.*for (const file of \[\([^]]*\)\]).*/\1/p" "$BETA_PACKAGE_SCRIPT" \
      | tr ',' '\n' \
      | sed -n "s/^[[:space:]]*'\([^']*\.md\)'[[:space:]]*$/\1/p"
  )
fi
if [ "${#ARTEFACT_MARKDOWN[@]}" -eq 0 ]; then
  ARTEFACT_MARKDOWN=("${ARTEFACT_MARKDOWN_FALLBACK[@]}")
fi

if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "Base commit ${base} is not available in this checkout." >&2
  exit 2
fi
if ! git cat-file -e "${head}^{commit}" 2>/dev/null; then
  echo "Head commit ${head} is not available in this checkout." >&2
  exit 2
fi

# --no-renames keeps the source path of a rename in the list, so moving a
# source file into docs/ is still treated as a code change.
if ! changed="$(git diff --no-renames --name-only "$base" "$head")"; then
  echo "Could not diff ${base}..${head}." >&2
  exit 2
fi

if [ "$list_only" = true ]; then
  printf '%s\n' "$changed"
  exit 0
fi

documentation_only=true
ci_only=true
count=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  count=$((count + 1))

  artefact=false
  for candidate in "${ARTEFACT_MARKDOWN[@]}"; do
    if [ "$path" = "$candidate" ]; then
      artefact=true
      break
    fi
  done
  if [ "$artefact" = true ]; then
    documentation_only=false
    ci_only=false
    continue
  fi

  case "$path" in
    docs/*|*.md) ;;
    .github/workflows/*|.github/actions/*|scripts/ci-*.sh|scripts/ci-*.mjs|scripts/tests/ci-*.mjs|scripts/install-playwright-deps.sh|scripts/playwright-deps-packages.mjs)
      # CI and release tooling. It has to be verified by the heavy suites,
      # but it is not part of any image, so production does not change.
      documentation_only=false
      ;;
    *) documentation_only=false; ci_only=false ;;
  esac
done <<< "$changed"

if [ "$scope_only" = true ]; then
  if [ "$count" -eq 0 ] || [ "$documentation_only" = true ]; then
    echo "documentation"
  elif [ "$ci_only" = true ]; then
    echo "ci-only"
  else
    echo "deployable"
  fi
  exit 0
fi

if [ "$count" -eq 0 ] || [ "$documentation_only" = true ]; then
  exit 0
fi
exit 1
