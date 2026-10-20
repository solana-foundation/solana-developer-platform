#!/usr/bin/env bash
# Boots the local paymasters and hands their addresses to the API:
#   devnet  — Kora in Docker against a real devnet RPC (Doppler KORA_DEVNET_RPC_URL)
#   mainnet — Kora in Docker against a Surfpool mainnet fork (scripts/kora-surfpool),
#             only when SOLANA_MAINNET_RPC_URL or SURFPOOL_REMOTE_RPC_URL is set
# Writes .secrets/kora-local/api.env, which apps/sdp-api/scripts/lib/dev-env.mjs
# loads under the developer's own .env.local. Run under Doppler (pnpm dev)
# so the RPC URLs and the funded devnet signer come from the dev config.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_LOCAL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-local"}"
SIGNER_CACHE_FILE="${STATE_DIR}/devnet.env"
MAINNET_STATE_DIR="${STATE_DIR}/mainnet"
API_ENV_FILE="${STATE_DIR}/api.env"

# Mainnet keeps the harness default (18080) so its Linux Docker-to-Surfpool
# forwarder stays on; devnet takes the next port. Both Redis ports sit off 6379
# so the stack's own Redis keeps it.
DEVNET_PORT=18081
DEVNET_REDIS_PORT=16379
MAINNET_PORT=18080
MAINNET_REDIS_PORT=16380

# Compose and the harness both honour inherited Kora settings; drop them so the
# ports above are the ones the services get and api.env stays in step.
unset KORA_PORT RPC_URL KORA_RPC_URL KORA_SURFPOOL_KORA_RPC_URL

# Prints KEY's value from a KEY=VALUE file, without surrounding quotes.
env_value() { sed -n "/^$2=/{s///p;q;}" "$1" | tr -d "'\""; }

command -v docker >/dev/null 2>&1 || { echo "docker is required for local Kora." >&2; exit 1; }
mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"

# --- devnet -----------------------------------------------------------------
# Signer: Doppler's funded key, else the one generated on an earlier run, else a new one.
devnet_signer="${KORA_SIGNER_PRIVATE_KEY:-}"
if [ -z "${devnet_signer}" ] && [ -f "${SIGNER_CACHE_FILE}" ]; then
  devnet_signer="$(env_value "${SIGNER_CACHE_FILE}" SIGNER_PRIVATE_KEY)"
fi
if [ -z "${devnet_signer}" ]; then
  echo "Generating a local devnet Kora signer (no KORA_SIGNER_PRIVATE_KEY in env)."
  devnet_signer="$(pnpm --silent --filter @sdp/api keygen:local --quiet)"
  echo "SIGNER_PRIVATE_KEY=${devnet_signer}" >"${SIGNER_CACHE_FILE}"
  chmod 600 "${SIGNER_CACHE_FILE}"
  fresh_devnet_signer=1
fi

echo "Starting devnet Kora on 127.0.0.1:${DEVNET_PORT}."
COMPOSE_PROJECT_NAME=kora-devnet KORA_PORT="${DEVNET_PORT}" KORA_REDIS_PORT="${DEVNET_REDIS_PORT}" \
  RPC_URL="${KORA_DEVNET_RPC_URL:-https://api.devnet.solana.com}" SIGNER_PRIVATE_KEY="${devnet_signer}" \
  docker compose -f "${ROOT_DIR}/infra/kora/docker-compose.yml" up -d redis kora

# `compose up -d` succeeds even when the container then crash-loops.
devnet_ready=""
for _ in $(seq 60); do
  if curl -fsS "http://127.0.0.1:${DEVNET_PORT}/liveness" >/dev/null 2>&1; then
    devnet_ready=1
    break
  fi
  sleep 1
done
[ -n "${devnet_ready}" ] || { echo "Devnet Kora did not become healthy on 127.0.0.1:${DEVNET_PORT}; see \`docker compose -p kora-devnet logs kora\`." >&2; exit 1; }

# --- mainnet (Surfpool fork) ------------------------------------------------
mainnet_upstream_rpc="${SURFPOOL_REMOTE_RPC_URL:-${SOLANA_MAINNET_RPC_URL:-}}"
surfpool_rpc_url=""
if [ -n "${mainnet_upstream_rpc}" ]; then
  echo "Starting mainnet Kora on 127.0.0.1:${MAINNET_PORT} against a Surfpool fork."
  COMPOSE_PROJECT_NAME=kora-mainnet KORA_SURFPOOL_MODE=docker KORA_SURFPOOL_STATE_DIR="${MAINNET_STATE_DIR}" \
    SURFPOOL_REMOTE_RPC_URL="${mainnet_upstream_rpc}" KORA_REDIS_PORT="${MAINNET_REDIS_PORT}" \
    "${ROOT_DIR}/scripts/kora-surfpool/up.sh"
  surfpool_rpc_url="$(env_value "${MAINNET_STATE_DIR}/runtime.env" SURFPOOL_RPC_URL)"
  [ -n "${surfpool_rpc_url}" ] || { echo "Surfpool did not report an RPC URL." >&2; exit 1; }
else
  echo "Skipping mainnet Kora: set SOLANA_MAINNET_RPC_URL (Doppler dev has it) or SURFPOOL_REMOTE_RPC_URL to fork mainnet."
fi

# --- hand-off to the API ----------------------------------------------------
# The per-cluster Kora URLs override Doppler's deployed Koras (empty audiences:
# the local Koras are plain HTTP, and a Doppler audience would reject them), and the
# mainnet RPCs point at the fork so the API, its fee preflight and its paymaster see one chain.
{
  echo "KORA_DEVNET_URL=http://127.0.0.1:${DEVNET_PORT}"
  echo "KORA_DEVNET_CLOUD_RUN_AUDIENCE="
  if [ -n "${surfpool_rpc_url}" ]; then
    echo "KORA_MAINNET_URL=http://127.0.0.1:${MAINNET_PORT}"
    echo "KORA_MAINNET_CLOUD_RUN_AUDIENCE="
    echo "SOLANA_MAINNET_RPC_URL=${surfpool_rpc_url}"
    echo "KORA_MAINNET_RPC_URL=${surfpool_rpc_url}"
  fi
  # The door builds Production transactions from the managed mainnet pool: only the fork, so
  # nothing reaches real mainnet through a provider URL inherited from Doppler. Written even
  # without a fork (the default then empty), so that run has no mainnet pool at all.
  for provider in TRITON HELIUS ALCHEMY QUICKNODE VALIDATIONCLOUD NODIT; do
    echo "SOLANA_RPC_${provider}_MAINNET_API_KEY_URL="
  done
  echo "SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL=${surfpool_rpc_url}"
} >"${API_ENV_FILE}"

echo "Local paymasters ready; API env written to ${API_ENV_FILE#"${ROOT_DIR}"/}."
if [ -n "${fresh_devnet_signer:-}" ]; then
  echo "The generated devnet fee payer holds no SOL. Fund it from the devnet faucet, or set KORA_SIGNER_PRIVATE_KEY (Doppler dev has a funded one)."
fi
