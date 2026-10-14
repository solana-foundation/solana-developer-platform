#!/usr/bin/env bash
# Boots both local paymasters and hands their addresses to the API:
#   devnet  — Kora in Docker against a real devnet RPC (Doppler KORA_DEVNET_RPC_URL)
#   mainnet — Kora in Docker against a Surfpool mainnet fork (scripts/kora-surfpool)
# Writes .secrets/kora-local/api.env, which apps/sdp-api/scripts/dev-local.mjs
# loads under the developer's own .env.local. Run under Doppler (pnpm dev:kora)
# so the RPC URLs and the funded devnet signer come from the dev config.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_LOCAL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-local"}"
DEVNET_ENV_FILE="${STATE_DIR}/devnet.env"
MAINNET_STATE_DIR="${STATE_DIR}/mainnet"
API_ENV_FILE="${STATE_DIR}/api.env"

# Mainnet keeps the harness default (18080) so its Linux Docker-to-Surfpool
# forwarder stays on; devnet takes the next port.
KORA_LOCAL_DEVNET_PORT="${KORA_LOCAL_DEVNET_PORT:-18081}"
KORA_LOCAL_MAINNET_PORT=18080
# Surfpool forks this upstream; without it the harness picks a devnet provider.
SURFPOOL_REMOTE_RPC_URL="${SURFPOOL_REMOTE_RPC_URL:-${SOLANA_MAINNET_RPC_URL:-}}"
# Compose interpolates the shell before --env-file, and the harness honours an
# inherited Kora endpoint; drop them so the ports below are the ones the
# services get and api.env stays in step.
unset KORA_PORT RPC_URL KORA_RPC_URL KORA_SURFPOOL_KORA_RPC_URL
# Off the default 6379 so the stack's own Redis keeps its port.
KORA_LOCAL_DEVNET_REDIS_PORT="${KORA_LOCAL_DEVNET_REDIS_PORT:-16379}"
KORA_LOCAL_MAINNET_REDIS_PORT="${KORA_LOCAL_MAINNET_REDIS_PORT:-16380}"

mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"

command -v docker >/dev/null 2>&1 || { echo "docker is required for local Kora." >&2; exit 1; }
[ -n "${SURFPOOL_REMOTE_RPC_URL}" ] || { echo "Set SOLANA_MAINNET_RPC_URL (Doppler dev has it) or SURFPOOL_REMOTE_RPC_URL; the mainnet Kora needs a mainnet fork." >&2; exit 1; }

# --- devnet -----------------------------------------------------------------
devnet_signer="${KORA_SIGNER_PRIVATE_KEY:-}"
if [ -z "${devnet_signer}" ] && [ -f "${DEVNET_ENV_FILE}" ]; then
  devnet_signer="$(awk -F= '$1 == "SIGNER_PRIVATE_KEY" { print substr($0, index($0, "=") + 1); exit }' "${DEVNET_ENV_FILE}")"
fi
if [ -z "${devnet_signer}" ]; then
  echo "Generating a local devnet Kora signer (no KORA_SIGNER_PRIVATE_KEY in env)."
  devnet_signer="$(pnpm --silent --filter @sdp/api keygen:local --quiet)"
  fresh_devnet_signer=1
fi

devnet_rpc="${KORA_DEVNET_RPC_URL:-https://api.devnet.solana.com}"
{
  echo "RPC_URL=${devnet_rpc}"
  echo "SIGNER_PRIVATE_KEY=${devnet_signer}"
  echo "KORA_PORT=${KORA_LOCAL_DEVNET_PORT}"
  echo "KORA_REDIS_PORT=${KORA_LOCAL_DEVNET_REDIS_PORT}"
} >"${DEVNET_ENV_FILE}"
chmod 600 "${DEVNET_ENV_FILE}"

echo "Starting devnet Kora on 127.0.0.1:${KORA_LOCAL_DEVNET_PORT}."
COMPOSE_PROJECT_NAME=kora-devnet RPC_URL="${devnet_rpc}" SIGNER_PRIVATE_KEY="${devnet_signer}" \
  KORA_PORT="${KORA_LOCAL_DEVNET_PORT}" KORA_REDIS_PORT="${KORA_LOCAL_DEVNET_REDIS_PORT}" \
  docker compose --env-file "${DEVNET_ENV_FILE}" -f "${ROOT_DIR}/infra/kora/docker-compose.yml" up -d redis kora

# --- mainnet (Surfpool fork) ------------------------------------------------
echo "Starting mainnet Kora on 127.0.0.1:${KORA_LOCAL_MAINNET_PORT} against a Surfpool fork."
COMPOSE_PROJECT_NAME=kora-mainnet \
  KORA_SURFPOOL_MODE=docker \
  SURFPOOL_REMOTE_RPC_URL="${SURFPOOL_REMOTE_RPC_URL}" \
  KORA_REDIS_PORT="${KORA_LOCAL_MAINNET_REDIS_PORT}" \
  KORA_SURFPOOL_STATE_DIR="${MAINNET_STATE_DIR}" \
  "${ROOT_DIR}/scripts/kora-surfpool/up.sh"

surfpool_rpc_url="$(awk -F= '$1 == "SURFPOOL_RPC_URL" { v = substr($0, index($0, "=") + 1); gsub(/^'"'"'|'"'"'$/, "", v); print v; exit }' "${MAINNET_STATE_DIR}/runtime.env")"
[ -n "${surfpool_rpc_url}" ] || { echo "Surfpool did not report an RPC URL." >&2; exit 1; }

# --- hand-off to the API ----------------------------------------------------
# Suffixed KORA_*_<CLUSTER> wins over Doppler's bare KORA_RPC_URL, and the
# mainnet RPC points at the fork so the API and its paymaster see one chain.
{
  echo "FEE_PAYMENT_PROVIDER=kora"
  echo "KORA_RPC_URL_DEVNET=http://127.0.0.1:${KORA_LOCAL_DEVNET_PORT}"
  echo "KORA_RPC_URL_MAINNET=http://127.0.0.1:${KORA_LOCAL_MAINNET_PORT}"
  echo "SOLANA_MAINNET_RPC_URL=${surfpool_rpc_url}"
} >"${API_ENV_FILE}"

echo "Local paymasters ready; API env written to ${API_ENV_FILE#"${ROOT_DIR}"/}."
if [ -n "${fresh_devnet_signer:-}" ]; then
  echo "The generated devnet fee payer holds no SOL. Fund it from the devnet faucet, or set KORA_SIGNER_PRIVATE_KEY (Doppler dev has a funded one)."
fi
