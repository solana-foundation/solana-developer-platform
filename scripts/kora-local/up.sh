#!/usr/bin/env bash
# Boots the local paymasters and hands their addresses to the API:
#   devnet  — Kora in Docker against a real devnet RPC (Doppler KORA_DEVNET_RPC_URL)
#   mainnet — Kora in Docker against a Surfpool mainnet fork (scripts/kora-surfpool),
#             only when SOLANA_MAINNET_RPC_URL or SURFPOOL_REMOTE_RPC_URL is set
# Writes .secrets/kora-local/api.env, which apps/sdp-api/scripts/lib/dev-env.mjs
# loads under the developer's own .env.local. Run under Doppler (pnpm dev)
# so the RPC URLs come from the dev config.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_LOCAL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-local"}"
# Machine-wide state every worktree shares, like the Kora containers themselves:
# one test-only fee payer for both clusters, so funding it on devnet once lasts (never
# the deployed KMS payer: a local Kora signs whatever it is sent, including a transaction
# built against real mainnet), the API key both local Koras require, and the one Surfpool
# fork the mainnet Kora runs against.
MACHINE_DIR="${XDG_CONFIG_HOME:-"${HOME}/.config"}/sdp"
SIGNER_CACHE_FILE="${MACHINE_DIR}/kora-local-signer.env"
API_KEY_FILE="${MACHINE_DIR}/kora-local-api-key.env"
MAINNET_STATE_DIR="${MACHINE_DIR}/kora-mainnet"
LOCK_DIR="${MACHINE_DIR}/kora-local.lock"
LOCK_TIMEOUT_SECONDS=300
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
mkdir -p "${STATE_DIR}" "${MACHINE_DIR}"
chmod 700 "${STATE_DIR}" "${MACHINE_DIR}"

# One start at a time across worktrees: the signer, the API key, both containers and the
# fork are shared, so a second caller waits and then reuses what the first one started.
# mkdir is the atomic claim (flock is not on macOS); a dead holder's lock is taken over.
# ponytail: two waiters can both reap the same dead holder's lock; serialize the reap if that ever bites.
waited=0
until mkdir "${LOCK_DIR}" 2>/dev/null; do
  holder="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  if [ -n "${holder}" ] && ! kill -0 "${holder}" 2>/dev/null; then
    rm -rf "${LOCK_DIR}"
    continue
  fi
  [ "${waited}" -lt "${LOCK_TIMEOUT_SECONDS}" ] || { echo "Another local Kora start (pid ${holder:-unknown}) still holds ${LOCK_DIR} after ${LOCK_TIMEOUT_SECONDS}s." >&2; exit 1; }
  [ "${waited}" -gt 0 ] || echo "Waiting for another worktree's local Kora start to finish."
  sleep 1
  waited=$((waited + 1))
done
echo "$$" >"${LOCK_DIR}/pid"
trap 'rm -rf "${LOCK_DIR}"' EXIT

# --- devnet -----------------------------------------------------------------
# Published with a hard link, which fails when the file exists: two first runs racing
# both read whichever key landed, and a reader never sees a half-written file.
if [ ! -f "${SIGNER_CACHE_FILE}" ]; then
  echo "Generating the local Kora fee payer at ${SIGNER_CACHE_FILE}."
  new_signer="$(pnpm --silent --filter @sdp/api keygen:local --quiet)"
  [ -n "${new_signer}" ] || { echo "keygen:local printed no key." >&2; exit 1; }
  signer_tmp="$(mktemp "${SIGNER_CACHE_FILE}.XXXXXX")"
  echo "SIGNER_PRIVATE_KEY=${new_signer}" >"${signer_tmp}"
  ln "${signer_tmp}" "${SIGNER_CACHE_FILE}" 2>/dev/null || true
  rm -f "${signer_tmp}"
fi
signer="$(env_value "${SIGNER_CACHE_FILE}" SIGNER_PRIVATE_KEY)"
[ -n "${signer}" ] || { echo "${SIGNER_CACHE_FILE} has no SIGNER_PRIVATE_KEY; delete it to generate a new fee payer." >&2; exit 1; }

# Without a key, any web page open in a browser on this machine could drive the local
# Koras' signing methods (Kora allows every CORS origin).
if [ ! -f "${API_KEY_FILE}" ]; then
  (umask 077 && echo "KORA_API_KEY=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" >"${API_KEY_FILE}")
fi
kora_api_key="$(env_value "${API_KEY_FILE}" KORA_API_KEY)"
[ -n "${kora_api_key}" ] || { echo "${API_KEY_FILE} has no KORA_API_KEY; delete it to generate a new one." >&2; exit 1; }

devnet_rpc_url="${KORA_DEVNET_RPC_URL:-https://api.devnet.solana.com}"
echo "Starting devnet Kora on 127.0.0.1:${DEVNET_PORT}."
COMPOSE_PROJECT_NAME=kora-devnet KORA_PORT="${DEVNET_PORT}" KORA_REDIS_PORT="${DEVNET_REDIS_PORT}" \
  RPC_URL="${devnet_rpc_url}" SIGNER_PRIVATE_KEY="${signer}" \
  KORA_API_KEY="${kora_api_key}" docker compose -f "${ROOT_DIR}/infra/kora/docker-compose.yml" up -d redis kora

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
  # The fork airdrops the shared fee payer SOL on boot.
  SIGNER_PRIVATE_KEY="${signer}" KORA_API_KEY="${kora_api_key}" COMPOSE_PROJECT_NAME=kora-mainnet KORA_SURFPOOL_MODE=docker KORA_SURFPOOL_SHARED=1 KORA_SURFPOOL_STATE_DIR="${MAINNET_STATE_DIR}" \
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
# Each Kora URL goes out with its upstream RPC, set or blank together: the API refuses to boot
# on a half-configured cluster (assertKoraConfigured).
{
  echo "KORA_DEVNET_URL=http://127.0.0.1:${DEVNET_PORT}"
  echo "KORA_DEVNET_RPC_URL=${devnet_rpc_url}"
  echo "KORA_DEVNET_API_KEY=${kora_api_key}"
  echo "KORA_DEVNET_CLOUD_RUN_AUDIENCE="
  if [ -n "${surfpool_rpc_url}" ]; then
    echo "KORA_MAINNET_URL=http://127.0.0.1:${MAINNET_PORT}"
    echo "KORA_MAINNET_API_KEY=${kora_api_key}"
    echo "KORA_MAINNET_CLOUD_RUN_AUDIENCE="
    echo "SOLANA_MAINNET_RPC_URL=${surfpool_rpc_url}"
    echo "KORA_MAINNET_RPC_URL=${surfpool_rpc_url}"
  else
    # No fork: blank Doppler's deployed mainnet Kora too, so the API reports no mainnet sponsor.
    echo "KORA_MAINNET_URL="
    echo "KORA_MAINNET_RPC_URL="
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
fee_payer="$(curl -fsS -X POST "http://127.0.0.1:${DEVNET_PORT}" -H 'content-type: application/json' \
  -H @<(printf 'x-api-key: %s\n' "${kora_api_key}") --data '{"jsonrpc":"2.0","id":1,"method":"getPayerSigner","params":[]}' | sed -n 's/.*"signer_address":"\([^"]*\)".*/\1/p')"
echo "Local fee payer ${fee_payer}: keep it funded on devnet (https://faucet.solana.com)."
