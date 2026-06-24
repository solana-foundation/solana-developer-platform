#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cleanup() {
  "${ROOT_DIR}/scripts/kora-surfpool/down.sh"
}
trap cleanup EXIT

export SURFPOOL_RPC_URL="${SURFPOOL_RPC_URL:-http://127.0.0.1:8899}"
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-${SURFPOOL_RPC_URL}}"
export SOLANA_RPC_CI_PREFERRED_PROVIDER="${SOLANA_RPC_CI_PREFERRED_PROVIDER:-default}"
export KORA_RPC_URL="${KORA_RPC_URL:-http://127.0.0.1:18080}"
export FEE_PAYMENT_PROVIDER="${FEE_PAYMENT_PROVIDER:-kora}"
export RUN_INTEGRATION_TESTS="${RUN_INTEGRATION_TESTS:-true}"
export KORA_SURFPOOL_SHIM="${KORA_SURFPOOL_SHIM:-true}"
export PRIVY_APP_ID="${PRIVY_APP_ID:-kora-surfpool-local}"
export PRIVY_APP_SECRET="${PRIVY_APP_SECRET:-kora-surfpool-local}"

"${ROOT_DIR}/scripts/kora-surfpool/up.sh"
pnpm --filter @sdp/api-integration exec vitest run \
  src/tests/kora.test.ts \
  src/tests/kora-surfpool-shim.test.ts
