#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_SURFPOOL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-surfpool"}"
ENV_FILE="${STATE_DIR}/kora.env"
SURFPOOL_LOG="${STATE_DIR}/surfpool.log"
SURFPOOL_PID_FILE="${STATE_DIR}/surfpool.pid"

SURFPOOL_HOST="${SURFPOOL_HOST:-127.0.0.1}"
SURFPOOL_PORT="${SURFPOOL_PORT:-8899}"
SURFPOOL_RPC_URL="${SURFPOOL_RPC_URL:-http://${SURFPOOL_HOST}:${SURFPOOL_PORT}}"
KORA_RPC_URL="${KORA_RPC_URL:-http://127.0.0.1:18080}"
KORA_DOCKER_RPC_URL="${KORA_DOCKER_RPC_URL:-http://host.docker.internal:${SURFPOOL_PORT}}"
KORA_FEE_PAYER_LAMPORTS="${KORA_FEE_PAYER_LAMPORTS:-10000000000}"
KORA_IMAGE="${KORA_IMAGE:-ghcr.io/solana-foundation/kora:61add05}"
KORA_PLATFORM="${KORA_PLATFORM:-linux/amd64}"
KORA_REDIS_PORT="${KORA_REDIS_PORT:-0}"
KORA_SURFPOOL_MODE="${KORA_SURFPOOL_MODE:-shim}"
KORA_SHIM_LOG="${STATE_DIR}/kora-shim.log"
KORA_SHIM_PID_FILE="${STATE_DIR}/kora-shim.pid"

mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required for local Kora-on-Surfpool tests." >&2
    exit 1
  fi
}

json_rpc_ok() {
  local url="$1"
  node - "${url}" <<'NODE' >/dev/null 2>&1
const url = process.argv[2];
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getLatestBlockhash",
    params: [{ commitment: "confirmed" }],
  }),
});
const payload = await response.json();
if (!payload.result?.value?.blockhash) process.exit(1);
NODE
}

wait_for_json_rpc() {
  local label="$1"
  local url="$2"
  local attempts="${3:-60}"
  for _ in $(seq 1 "${attempts}"); do
    if json_rpc_ok "${url}"; then
      return 0
    fi
    sleep 1
  done
  echo "${label} did not become healthy at ${url}." >&2
  return 1
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local attempts="${3:-60}"
  for _ in $(seq 1 "${attempts}"); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "${label} did not become healthy at ${url}." >&2
  return 1
}

wait_for_kora() {
  local attempts="${1:-60}"
  for _ in $(seq 1 "${attempts}"); do
    if curl -fsS "${KORA_RPC_URL}/health" >/dev/null 2>&1; then
      return 0
    fi
    if curl -fsS "${KORA_RPC_URL}/liveness" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Kora did not become healthy at ${KORA_RPC_URL}." >&2
  return 1
}

require_command curl
require_command node
require_command pnpm
require_command surfpool

if json_rpc_ok "${SURFPOOL_RPC_URL}"; then
  echo "Surfpool RPC is already healthy at ${SURFPOOL_RPC_URL}."
else
  echo "Starting Surfpool RPC at ${SURFPOOL_RPC_URL}."
  NO_DNA=1 surfpool start --ci --host "${SURFPOOL_HOST}" --port "${SURFPOOL_PORT}" --no-deploy >"${SURFPOOL_LOG}" 2>&1 &
  echo "$!" >"${SURFPOOL_PID_FILE}"
  wait_for_json_rpc "Surfpool" "${SURFPOOL_RPC_URL}" 90
fi

if [ -f "${ENV_FILE}" ] && [ -z "${SIGNER_PRIVATE_KEY:-}" ]; then
  SIGNER_PRIVATE_KEY="$(
    awk -F= '$1 == "SIGNER_PRIVATE_KEY" { print substr($0, index($0, "=") + 1); exit }' "${ENV_FILE}"
  )"
fi

if [ -z "${SIGNER_PRIVATE_KEY:-}" ]; then
  echo "Generating test-only Kora memory signer."
  SIGNER_PRIVATE_KEY="$(pnpm --silent --filter @sdp/api keygen:local --quiet)"
fi

umask 077
cat >"${ENV_FILE}" <<EOF
RPC_URL=${KORA_DOCKER_RPC_URL}
SIGNER_PRIVATE_KEY=${SIGNER_PRIVATE_KEY}
KORA_IMAGE=${KORA_IMAGE}
KORA_PLATFORM=${KORA_PLATFORM}
KORA_REDIS_PORT=${KORA_REDIS_PORT}
EOF

case "${KORA_SURFPOOL_MODE}" in
  shim)
    KORA_SHIM_HOST="$(
      node - "${KORA_RPC_URL}" <<'NODE'
const parsed = new URL(process.argv[2]);
process.stdout.write(parsed.hostname || "127.0.0.1");
NODE
    )"
    KORA_SHIM_PORT="$(
      node - "${KORA_RPC_URL}" <<'NODE'
const parsed = new URL(process.argv[2]);
process.stdout.write(parsed.port || (parsed.protocol === "https:" ? "443" : "80"));
NODE
    )"
    echo "Starting Kora-compatible shim with upstream RPC ${SURFPOOL_RPC_URL}."
    if [ -f "${KORA_SHIM_PID_FILE}" ]; then
      old_pid="$(cat "${KORA_SHIM_PID_FILE}")"
      if [ -n "${old_pid}" ] && kill -0 "${old_pid}" >/dev/null 2>&1; then
        kill "${old_pid}" >/dev/null 2>&1 || true
      fi
      rm -f "${KORA_SHIM_PID_FILE}"
    fi
    (
      cd "${ROOT_DIR}/packages/sdp-api-integration"
      KORA_SHIM_HOST="${KORA_SHIM_HOST}" \
        KORA_SHIM_PORT="${KORA_SHIM_PORT}" \
        SOLANA_RPC_URL="${SURFPOOL_RPC_URL}" \
        SIGNER_PRIVATE_KEY="${SIGNER_PRIVATE_KEY}" \
        pnpm exec node scripts/kora-surfpool-shim.mjs
    ) >"${KORA_SHIM_LOG}" 2>&1 &
    echo "$!" >"${KORA_SHIM_PID_FILE}"
    ;;
  docker)
    require_command docker
    echo "Starting local Kora with upstream RPC ${KORA_DOCKER_RPC_URL}."
    docker compose --env-file "${ENV_FILE}" -f "${ROOT_DIR}/infra/kora/docker-compose.yml" up -d redis kora
    ;;
  *)
    echo "Unsupported KORA_SURFPOOL_MODE=${KORA_SURFPOOL_MODE}. Expected 'shim' or 'docker'." >&2
    exit 1
    ;;
esac
wait_for_kora 90

FEE_PAYER="$(node - "${KORA_RPC_URL}" <<'NODE'
const url = process.argv[2];
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getPayerSigner",
    params: [],
  }),
});
const payload = await response.json();
if (payload.error) throw new Error(payload.error.message);
const result = payload.result ?? {};
const address = result.signer_address ?? result.payment_address ?? result.payerSigner;
if (!address) throw new Error("Kora did not return a fee payer address.");
process.stdout.write(address);
NODE
)"

echo "Funding local Kora fee payer ${FEE_PAYER} on Surfpool."
node - "${SURFPOOL_RPC_URL}" "${FEE_PAYER}" "${KORA_FEE_PAYER_LAMPORTS}" <<'NODE'
const [url, address, lamports] = process.argv.slice(2);

async function rpc(method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.result;
}

await rpc("requestAirdrop", [address, Number(lamports)]);
for (let attempt = 0; attempt < 30; attempt += 1) {
  const balance = await rpc("getBalance", [address, { commitment: "confirmed" }]);
  if ((balance.value ?? 0) >= Number(lamports)) {
    process.stdout.write(String(balance.value));
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
throw new Error(`Kora fee payer ${address} was not funded on Surfpool.`);
NODE
echo

cat <<EOF
Local Kora-on-Surfpool is ready.

Use these environment overrides with Doppler-backed commands:
  export SOLANA_RPC_URL=${SURFPOOL_RPC_URL}
  export SOLANA_RPC_CI_PREFERRED_PROVIDER=default
  export KORA_RPC_URL=${KORA_RPC_URL}
  export FEE_PAYMENT_PROVIDER=kora
  export RUN_INTEGRATION_TESTS=true

Try:
  pnpm kora:surfpool:test

Stop services:
  pnpm kora:surfpool:down
EOF
