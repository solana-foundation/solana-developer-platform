#!/usr/bin/env bash
set -euo pipefail

KORA_RPC_URL="${KORA_RPC_URL:-https://kora-devnet-315956366746.us-central1.run.app}"

if [[ -n "${KORA_API_KEY:-}" ]]; then
  curl -s -H "x-api-key: ${KORA_API_KEY}" "${KORA_RPC_URL}/liveness"
else
  curl -s "${KORA_RPC_URL}/liveness"
fi
echo
