#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_SURFPOOL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-surfpool"}"
ENV_FILE="${STATE_DIR}/kora.env"
RUNTIME_ENV_FILE="${STATE_DIR}/runtime.env"
SURFPOOL_LOG="${STATE_DIR}/surfpool.log"
SURFPOOL_PID_FILE="${STATE_DIR}/surfpool.pid"
SURFPOOL_INFO_FILE="${STATE_DIR}/surfpool.json"

KORA_FEE_PAYER_LAMPORTS="${KORA_FEE_PAYER_LAMPORTS:-10000000000}"
KORA_IMAGE="${KORA_IMAGE:-ghcr.io/solana-foundation/kora:61add05}"
KORA_PLATFORM="${KORA_PLATFORM:-linux/amd64}"
KORA_REDIS_PORT="${KORA_REDIS_PORT:-0}"
if [ -n "${KORA_SURFPOOL_KORA_RPC_URL:-}" ]; then
  KORA_RPC_URL="${KORA_SURFPOOL_KORA_RPC_URL}"
elif [ "${DOPPLER_RUN_ACTIVE:-}" = "1" ]; then
  KORA_RPC_URL="http://127.0.0.1:18080"
else
  KORA_RPC_URL="${KORA_RPC_URL:-http://127.0.0.1:18080}"
fi
KORA_SURFPOOL_MODE="${KORA_SURFPOOL_MODE:-shim}"
KORA_SURFPOOL_RUNTIME="${KORA_SURFPOOL_RUNTIME:-embedded}"
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

json_file_field() {
  local file="$1"
  local field="$2"
  node - "${file}" "${field}" <<'NODE'
const [file, field] = process.argv.slice(2);
const fs = await import("node:fs/promises");
const payload = JSON.parse(await fs.readFile(file, "utf8"));
const value = payload[field];
if (typeof value !== "string" || value.length === 0) {
  process.exit(1);
}
process.stdout.write(value);
NODE
}

shell_quote() {
  local value="$1"
  node - "${value}" <<'NODE'
const value = process.argv[2] ?? "";
process.stdout.write(`'${value.replaceAll("'", `'"'"'`)}'`);
NODE
}

configure_embedded_remote_rpc() {
  if [ -n "${SURFPOOL_REMOTE_RPC_URL:-}" ]; then
    echo "Using explicit Surfpool remote RPC override."
    export SURFPOOL_REMOTE_RPC_URL
    return 0
  fi

  local remote_rpc_url
  remote_rpc_url="$(node "${ROOT_DIR}/scripts/kora-surfpool/select-remote-rpc.mjs")"
  if [ -n "${remote_rpc_url}" ]; then
    SURFPOOL_REMOTE_RPC_URL="${remote_rpc_url}"
    export SURFPOOL_REMOTE_RPC_URL
  fi
}

embedded_surfpool_config_matches() {
  local file="$1"
  local remote_rpc_url="${SURFPOOL_REMOTE_RPC_URL:-}"
  node - "${file}" "${remote_rpc_url}" <<'NODE'
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [file, remoteRpcUrl] = process.argv.slice(2);
const payload = JSON.parse(await readFile(file, "utf8"));
const expectedDigest = remoteRpcUrl
  ? createHash("sha256").update(remoteRpcUrl).digest("hex")
  : undefined;
const actualDigest = payload.remoteRpcUrlSha256;

if (actualDigest !== expectedDigest) {
  process.exit(1);
}
NODE
}

url_port() {
  local url="$1"
  node - "${url}" <<'NODE'
const parsed = new URL(process.argv[2]);
process.stdout.write(parsed.port || (parsed.protocol === "https:" ? "443" : "80"));
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

wait_for_surfpool_info() {
  local attempts="${1:-60}"
  for _ in $(seq 1 "${attempts}"); do
    if [ -f "${SURFPOOL_INFO_FILE}" ]; then
      SURFPOOL_RPC_URL="$(json_file_field "${SURFPOOL_INFO_FILE}" rpcUrl)"
      if json_rpc_ok "${SURFPOOL_RPC_URL}"; then
        export SURFPOOL_RPC_URL
        return 0
      fi
    fi
    sleep 1
  done
  echo "Embedded Surfpool did not become healthy. See ${SURFPOOL_LOG}." >&2
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

stop_pid_file() {
  local pid_file="$1"
  if [ ! -f "${pid_file}" ]; then
    return 0
  fi
  local pid
  pid="$(cat "${pid_file}")"
  if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill -- -"${pid}" >/dev/null 2>&1 || kill "${pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${pid_file}"
}

start_embedded_surfpool() {
  if [ -f "${SURFPOOL_PID_FILE}" ]; then
    local old_pid
    old_pid="$(cat "${SURFPOOL_PID_FILE}")"
    if [ -n "${old_pid}" ] && kill -0 "${old_pid}" >/dev/null 2>&1; then
      if [ -f "${SURFPOOL_INFO_FILE}" ]; then
        SURFPOOL_RPC_URL="$(json_file_field "${SURFPOOL_INFO_FILE}" rpcUrl)"
        if embedded_surfpool_config_matches "${SURFPOOL_INFO_FILE}" && json_rpc_ok "${SURFPOOL_RPC_URL}"; then
          export SURFPOOL_RPC_URL
          echo "Embedded Surfpool RPC is already healthy at ${SURFPOOL_RPC_URL}."
          return 0
        fi
      fi
      stop_pid_file "${SURFPOOL_PID_FILE}"
    fi
  fi

  echo "Starting embedded Surfpool RPC."
  rm -f "${SURFPOOL_INFO_FILE}"
  (
    cd "${ROOT_DIR}/packages/sdp-api-integration"
    export SURFPOOL_INFO_FILE
    exec node scripts/kora-surfpool-surfnet.mjs
  ) >"${SURFPOOL_LOG}" 2>&1 &
  echo "$!" >"${SURFPOOL_PID_FILE}"
  wait_for_surfpool_info 90
}

start_cli_surfpool() {
  require_command surfpool
  local surfpool_host="${SURFPOOL_HOST:-127.0.0.1}"
  local surfpool_port="${SURFPOOL_PORT:-8899}"
  SURFPOOL_RPC_URL="${SURFPOOL_RPC_URL:-http://${surfpool_host}:${surfpool_port}}"
  export SURFPOOL_RPC_URL

  if json_rpc_ok "${SURFPOOL_RPC_URL}"; then
    echo "Surfpool RPC is already healthy at ${SURFPOOL_RPC_URL}."
    return 0
  fi

  echo "Starting Surfpool CLI RPC at ${SURFPOOL_RPC_URL}."
  NO_DNA=1 surfpool start --ci --host "${surfpool_host}" --port "${surfpool_port}" --no-deploy >"${SURFPOOL_LOG}" 2>&1 &
  echo "$!" >"${SURFPOOL_PID_FILE}"
  wait_for_json_rpc "Surfpool" "${SURFPOOL_RPC_URL}" 90
}

write_runtime_env() {
  umask 077
  {
    echo "SURFPOOL_RPC_URL=$(shell_quote "${SURFPOOL_RPC_URL}")"
    echo "SURFPOOL_REMOTE_RPC_URL=$(shell_quote "${SURFPOOL_REMOTE_RPC_URL:-}")"
    echo "SOLANA_RPC_URL=$(shell_quote "${SURFPOOL_RPC_URL}")"
    echo "SOLANA_RPC_CI_PREFERRED_PROVIDER=default"
    echo "KORA_RPC_URL=$(shell_quote "${KORA_RPC_URL}")"
    echo "FEE_PAYMENT_PROVIDER=kora"
    echo "RUN_INTEGRATION_TESTS=true"
    echo "KORA_SURFPOOL_SHIM=$([ "${KORA_SURFPOOL_MODE}" = "shim" ] && echo "true" || echo "false")"
    echo "PRIVY_APP_ID=$(shell_quote "${PRIVY_APP_ID:-kora-surfpool-local}")"
    echo "PRIVY_APP_SECRET=$(shell_quote "${PRIVY_APP_SECRET:-kora-surfpool-local}")"
  } >"${RUNTIME_ENV_FILE}"
}

require_command curl
require_command node
require_command pnpm

case "${KORA_SURFPOOL_RUNTIME}" in
  embedded)
    configure_embedded_remote_rpc
    start_embedded_surfpool
    ;;
  cli)
    start_cli_surfpool
    ;;
  external)
    if [ -z "${SURFPOOL_RPC_URL:-}" ]; then
      echo "SURFPOOL_RPC_URL is required when KORA_SURFPOOL_RUNTIME=external." >&2
      exit 1
    fi
    wait_for_json_rpc "External Surfpool" "${SURFPOOL_RPC_URL}" 30
    ;;
  *)
    echo "Unsupported KORA_SURFPOOL_RUNTIME=${KORA_SURFPOOL_RUNTIME}. Expected 'embedded', 'cli', or 'external'." >&2
    exit 1
    ;;
esac

if [ -f "${ENV_FILE}" ] && [ -z "${SIGNER_PRIVATE_KEY:-}" ]; then
  SIGNER_PRIVATE_KEY="$(
    awk -F= '$1 == "SIGNER_PRIVATE_KEY" { print substr($0, index($0, "=") + 1); exit }' "${ENV_FILE}"
  )"
fi

if [ -z "${SIGNER_PRIVATE_KEY:-}" ]; then
  echo "Generating test-only Kora memory signer."
  SIGNER_PRIVATE_KEY="$(pnpm --silent --filter @sdp/api keygen:local --quiet)"
fi

KORA_DOCKER_RPC_URL="${KORA_DOCKER_RPC_URL:-http://host.docker.internal:$(url_port "${SURFPOOL_RPC_URL}")}"

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
    stop_pid_file "${KORA_SHIM_PID_FILE}"
    (
      cd "${ROOT_DIR}/packages/sdp-api-integration"
      export KORA_SHIM_HOST
      export KORA_SHIM_PORT
      export SOLANA_RPC_URL="${SURFPOOL_RPC_URL}"
      export SIGNER_PRIVATE_KEY
      exec node scripts/kora-surfpool-shim.mjs
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

write_runtime_env

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
