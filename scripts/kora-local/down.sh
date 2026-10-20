#!/usr/bin/env bash
# Tears down both local paymasters started by up.sh, the shared Surfpool fork with them, and removes the API hand-off
# file so `pnpm dev:api` and `pnpm -C apps/sdp-api dev` go back to Doppler's Kora settings.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_LOCAL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-local"}"

COMPOSE_PROJECT_NAME=kora-mainnet KORA_SURFPOOL_STATE_DIR="${XDG_CONFIG_HOME:-"${HOME}/.config"}/sdp/kora-mainnet" \
  "${ROOT_DIR}/scripts/kora-surfpool/down.sh"

# Before the fork moved machine-wide it lived in each worktree's state dir; sweep a fork
# still recorded there, and the per-worktree signer cache that layout used.
if [ -d "${STATE_DIR}/mainnet" ]; then
  COMPOSE_PROJECT_NAME=kora-mainnet KORA_SURFPOOL_STATE_DIR="${STATE_DIR}/mainnet" \
    "${ROOT_DIR}/scripts/kora-surfpool/down.sh"
  rm -rf "${STATE_DIR}/mainnet"
fi
rm -f "${STATE_DIR}/devnet.env"

if command -v docker >/dev/null 2>&1; then
  COMPOSE_PROJECT_NAME=kora-devnet docker compose -f "${ROOT_DIR}/infra/kora/docker-compose.yml" down || true
fi

rm -f "${STATE_DIR}/api.env"
