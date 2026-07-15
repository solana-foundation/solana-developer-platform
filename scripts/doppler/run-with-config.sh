#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

env_files=()
for env_file in "$root"/apps/*/.dev.vars "$root"/apps/*/.env.local; do
  if [ -f "$env_file" ]; then
    env_files+=("${env_file#"$root"/}")
  fi
done

# Exports KEY=VALUE lines with the same inert-data semantics as every other
# consumer of these files (wrangler, Next.js, dev-local.mjs): split on the
# first "=", keep the value literal. Never `source` them — shell parsing would
# expand/execute characters like $, #, and backticks inside secret values.
load_env_files() {
  local file line key value
  for file in "$@"; do
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      case "$line" in '' | '#'*) continue ;; esac
      key="${line%%=*}"
      value="${line#*=}"
      case "$key" in
        [A-Za-z_]*) export "$key=$value" ;;
      esac
    done <"$root/$file"
  done
}

# Re-entry inside `doppler run`: overlay the local env files on top of the
# Doppler-injected environment, so files beat Doppler without letting stale
# shell exports beat either (no --preserve-env involved).
if [ "${1:-}" = "--overlay-env" ]; then
  shift
  if [ "${#env_files[@]}" -gt 0 ]; then
    load_env_files "${env_files[@]}"
  fi
  exec "$@"
fi

if [ "${DOPPLER_RUN_ACTIVE:-}" = "1" ]; then
  exec "$@"
fi

if [ -t 2 ]; then
  bold=$'\033[1m' dim=$'\033[2m' yellow=$'\033[33m' cyan=$'\033[36m' reset=$'\033[0m'
else
  bold="" dim="" yellow="" cyan="" reset=""
fi

if ! command -v doppler >/dev/null 2>&1; then
  echo "${bold}Solana Developer Platform${reset} recommends using a secrets manager like ${cyan}Doppler${reset} over plain environment files to share your keys: https://docs.doppler.com/docs/install-cli" >&2

  if [ "${#env_files[@]}" -gt 0 ]; then
    echo "Loading environment secrets from ${cyan}${env_files[*]}${reset}." >&2
    load_env_files "${env_files[@]}"
  else
    echo "${yellow}No local environment files found.${reset} Copy the examples to get started:" >&2
    echo "  cp apps/sdp-api/.dev.vars.example apps/sdp-api/.dev.vars" >&2
    echo "  cp apps/sdp-web/.env.local.example apps/sdp-web/.env.local" >&2
  fi

  exec "$@"
fi

project="${DOPPLER_PROJECT:-solana-developer-platform}"
config="${DOPPLER_CONFIG:-dev}"

overrides=""
if [ "${#env_files[@]}" -gt 0 ]; then
  overrides=" with local overrides from ${cyan}${env_files[*]}${reset}${dim}"
fi

echo "${dim}Loading environment secrets from Doppler (${project}/${config})${overrides}.${reset}" >&2

# Explicit opt-in for callers (CI jobs) whose exported vars must beat Doppler.
# Never defaulted: locally the env files above are the only override path.
doppler_args=(run --project "${project}" --config "${config}")
if [ -n "${DOPPLER_PRESERVE_ENV:-}" ]; then
  doppler_args+=(--preserve-env="${DOPPLER_PRESERVE_ENV}")
fi

exec doppler "${doppler_args[@]}" -- env DOPPLER_RUN_ACTIVE=1 DOPPLER_PROJECT="${project}" DOPPLER_CONFIG="${config}" "$root/scripts/doppler/run-with-config.sh" --overlay-env "$@"
