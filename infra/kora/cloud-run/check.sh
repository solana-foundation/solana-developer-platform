#!/usr/bin/env bash
set -euo pipefail

KORA_RPC_URL="${KORA_RPC_URL:-https://kora-devnet-315956366746.us-central1.run.app}"

if [[ -z "${KORA_API_KEY:-}" ]]; then
  echo "KORA_API_KEY is not set. Add it to apps/sdp-api/.dev.vars." >&2
  exit 1
fi

curl -s -H "x-api-key: ${KORA_API_KEY}" "${KORA_RPC_URL}/liveness"
echo
