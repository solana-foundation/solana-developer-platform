#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER="${VEDA_SURFPOOL_CLUSTER:-devnet}"
case "${CLUSTER}" in
  devnet) REMOTE_RPC_URL="${VEDA_SURFPOOL_DEVNET_RPC_URL:-${SURFPOOL_REMOTE_RPC_URL:-}}" ;;
  mainnet-beta) REMOTE_RPC_URL="${VEDA_SURFPOOL_MAINNET_RPC_URL:-${SURFPOOL_REMOTE_RPC_URL:-}}" ;;
  *) echo "VEDA_SURFPOOL_CLUSTER must be devnet or mainnet-beta." >&2; exit 1 ;;
esac

if [ -z "${REMOTE_RPC_URL}" ]; then
  echo "Set VEDA_SURFPOOL_DEVNET_RPC_URL or VEDA_SURFPOOL_MAINNET_RPC_URL for ${CLUSTER}." >&2
  exit 1
fi

if [ "${SDP_VEDA_SURFPOOL_IN_CONTAINER:-}" != "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required. This runner deliberately never invokes host Node or pnpm." >&2
    exit 1
  fi

  IMAGE="${VEDA_SURFPOOL_IMAGE:-sdp-veda-surfpool:local}"
  docker build \
    --platform linux/amd64 \
    --file "${ROOT_DIR}/scripts/kora-surfpool/Dockerfile.veda" \
    --tag "${IMAGE}" \
    "${ROOT_DIR}"

  exec docker run --rm --init \
    --platform linux/amd64 \
    --env SDP_VEDA_SURFPOOL_IN_CONTAINER=1 \
    --env VEDA_SURFPOOL_CLUSTER="${CLUSTER}" \
    --env SURFPOOL_REMOTE_RPC_URL="${REMOTE_RPC_URL}" \
    --env VEDA_SURFPOOL_E2E=true \
    "${IMAGE}"
fi

export SURFPOOL_REMOTE_RPC_URL="${REMOTE_RPC_URL}"
export VEDA_SURFPOOL_CLUSTER="${CLUSTER}"
export VEDA_SURFPOOL_E2E=true
export KORA_SURFPOOL_MODE=shim
export KORA_SURFPOOL_RUNTIME=embedded

exec pnpm kora:surfpool:run -- \
  pnpm --filter @sdp/veda exec vitest run \
    src/sdk.surfpool.test.ts \
    --no-file-parallelism \
    --testTimeout 240000 \
    --hookTimeout 240000
