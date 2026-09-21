#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "${name} is required." >&2
    return 1
  fi
}

missing=0
require_env WISDOMTREE_SURFPOOL_MAINNET_RPC_URL || missing=1
require_env WISDOMTREE_SURFPOOL_SIGNER_PRIVATE_KEY || missing=1
require_env WISDOMTREE_API_KEY || missing=1
if [ "${missing}" -ne 0 ]; then
  echo "The WisdomTree proof requires a mainnet RPC, packed Connect production credentials, and a user-controlled mainnet signer holding real SOL, USDC, WTGXX, and a live WisdomTree credential." >&2
  exit 1
fi

if [ "${SDP_WISDOMTREE_SURFPOOL_IN_CONTAINER:-}" != "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required. This runner deliberately never invokes host Node or pnpm." >&2
    exit 1
  fi

  IMAGE="${WISDOMTREE_SURFPOOL_IMAGE:-sdp-wisdomtree-surfpool:local}"
  docker build \
    --platform linux/amd64 \
    --file "${ROOT_DIR}/scripts/kora-surfpool/Dockerfile.wisdomtree" \
    --tag "${IMAGE}" \
    "${ROOT_DIR}"

  # Inherit secret values by ENV NAME only. No RPC credential, Connect
  # credential, or signer secret appears in Docker's process arguments.
  exec docker run --rm --init \
    --platform linux/amd64 \
    --env SDP_WISDOMTREE_SURFPOOL_IN_CONTAINER=1 \
    --env WISDOMTREE_SURFPOOL_MAINNET_RPC_URL \
    --env WISDOMTREE_SURFPOOL_SIGNER_PRIVATE_KEY \
    --env WISDOMTREE_API_KEY \
    "${IMAGE}"
fi

export SURFPOOL_REMOTE_RPC_URL="${WISDOMTREE_SURFPOOL_MAINNET_RPC_URL}"
export SOLANA_NETWORK=mainnet-beta
export WISDOMTREE_SURFPOOL_E2E=true

STATE_DIR="$(mktemp -d /tmp/sdp-wisdomtree-surfpool.XXXXXX)"
SURFPOOL_INFO_FILE="${STATE_DIR}/surfpool.json"
SURFPOOL_LOG="${STATE_DIR}/surfpool.log"
SURFPOOL_PID=""
export SURFPOOL_INFO_FILE

cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "${SURFPOOL_PID}" ] && kill -0 "${SURFPOOL_PID}" >/dev/null 2>&1; then
    kill "${SURFPOOL_PID}" >/dev/null 2>&1 || true
    wait "${SURFPOOL_PID}" >/dev/null 2>&1 || true
  fi
  if [ "${status}" -ne 0 ] && [ -f "${SURFPOOL_LOG}" ]; then
    echo "Embedded Surfpool log:" >&2
    # Surfpool was handed the remote RPC URL, and for most providers the API
    # key rides in that URL's query string; the 1.5.0 binary logs "connecting
    # to" / datasource-error lines verbatim. Redact before printing anything.
    if [ -n "${WISDOMTREE_SURFPOOL_MAINNET_RPC_URL}" ]; then
      tail -200 "${SURFPOOL_LOG}" |
        sed "s|${WISDOMTREE_SURFPOOL_MAINNET_RPC_URL}|<redacted rpc url>|g" >&2 || true
    else
      tail -200 "${SURFPOOL_LOG}" >&2 || true
    fi
  fi
  rm -rf "${STATE_DIR}"
  exit "${status}"
}
trap cleanup EXIT

node "${ROOT_DIR}/packages/sdp-api-integration/scripts/kora-surfpool-surfnet.mjs" \
  >"${SURFPOOL_LOG}" 2>&1 &
SURFPOOL_PID=$!

for _ in $(seq 1 90); do
  if [ -f "${SURFPOOL_INFO_FILE}" ]; then
    WISDOMTREE_SMOKE_RPC_URL="$(
      node - "${SURFPOOL_INFO_FILE}" <<'NODE'
import { readFile } from "node:fs/promises";
const payload = JSON.parse(await readFile(process.argv[2], "utf8"));
if (typeof payload.rpcUrl !== "string" || payload.rpcUrl.length === 0) process.exit(1);
process.stdout.write(payload.rpcUrl);
NODE
    )"
    if curl --fail --silent --show-error --max-time 2 \
      --header "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash","params":[{"commitment":"confirmed"}]}' \
      "${WISDOMTREE_SMOKE_RPC_URL}" >/dev/null; then
      export WISDOMTREE_SMOKE_RPC_URL
      break
    fi
  fi
  if ! kill -0 "${SURFPOOL_PID}" >/dev/null 2>&1; then
    echo "Embedded Surfpool exited before becoming healthy." >&2
    exit 1
  fi
  sleep 1
done

if [ -z "${WISDOMTREE_SMOKE_RPC_URL:-}" ]; then
  echo "Embedded Surfpool did not become healthy within 90 seconds." >&2
  exit 1
fi

pnpm --filter @sdp/wisdomtree exec vitest run \
  src/smoke.surfpool.test.ts \
  --no-file-parallelism \
  --testTimeout 300000 \
  --hookTimeout 300000
