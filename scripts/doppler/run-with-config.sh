#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

env_files=()
for env_file in "$root"/apps/*/.env.local; do
  if [ -f "$env_file" ]; then
    env_files+=("${env_file#"$root"/}")
  fi
done

# Exports KEY=VALUE lines with the same inert-data semantics as every other
# consumer of these files (Next.js and dev-local.mjs): split on the
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

if ! command -v doppler >/dev/null 2>&1; then
  if [ "${#env_files[@]}" -gt 0 ]; then
    load_env_files "${env_files[@]}"
  fi
  exec "$@"
fi

project="${DOPPLER_PROJECT:-solana-developer-platform}"
config="${DOPPLER_CONFIG:-dev}"

# Explicit opt-in for callers (CI jobs) whose exported vars must beat Doppler.
# Never defaulted: locally the env files above are the only override path.
doppler_args=(run --project "${project}" --config "${config}")
if [ -n "${DOPPLER_PRESERVE_ENV:-}" ]; then
  doppler_args+=(--preserve-env="${DOPPLER_PRESERVE_ENV}")
fi

exec doppler "${doppler_args[@]}" -- env DOPPLER_RUN_ACTIVE=1 DOPPLER_PROJECT="${project}" DOPPLER_CONFIG="${config}" "$root/scripts/doppler/run-with-config.sh" --overlay-env "$@"
