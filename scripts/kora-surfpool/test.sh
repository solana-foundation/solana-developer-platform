#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_SURFPOOL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-surfpool"}"
RUNTIME_ENV_FILE="${STATE_DIR}/runtime.env"

cleanup() {
  "${ROOT_DIR}/scripts/kora-surfpool/down.sh"
}
trap cleanup EXIT

if [ -n "${KORA_SURFPOOL_KORA_RPC_URL:-}" ]; then
  export KORA_RPC_URL="${KORA_SURFPOOL_KORA_RPC_URL}"
elif [ "${DOPPLER_RUN_ACTIVE:-}" = "1" ]; then
  export KORA_RPC_URL="http://127.0.0.1:18080"
else
  export KORA_RPC_URL="${KORA_RPC_URL:-http://127.0.0.1:18080}"
fi
export FEE_PAYMENT_PROVIDER="${FEE_PAYMENT_PROVIDER:-kora}"
export RUN_INTEGRATION_TESTS="${RUN_INTEGRATION_TESTS:-true}"
export KORA_SURFPOOL_SHIM="${KORA_SURFPOOL_SHIM:-true}"
export PRIVY_APP_ID="${PRIVY_APP_ID:-kora-surfpool-local}"
export PRIVY_APP_SECRET="${PRIVY_APP_SECRET:-kora-surfpool-local}"

"${ROOT_DIR}/scripts/kora-surfpool/up.sh"
if [ -f "${RUNTIME_ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${RUNTIME_ENV_FILE}"
  set +a
fi
pnpm --filter @sdp/api-integration exec vitest run \
  src/tests/kora.test.ts \
  src/tests/kora-surfpool-shim.test.ts
