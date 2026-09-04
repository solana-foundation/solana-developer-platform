#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -z "${JUPITER_LEND_MAINNET_RPC_URL:-}" ]; then
  echo "JUPITER_LEND_MAINNET_RPC_URL is required (Surfpool clones Jupiter's mainnet accounts from it)." >&2
  exit 1
fi

export SURFPOOL_REMOTE_RPC_URL="${JUPITER_LEND_MAINNET_RPC_URL}"
export SOLANA_NETWORK=mainnet-beta
export JUPITER_LEND_SURFPOOL_E2E=true
export SDP_INTEGRATION_SUITE=kora

exec "${ROOT_DIR}/scripts/kora-surfpool/integration.sh" -- \
  src/tests/jupiter-lend-products.surfpool.test.ts
