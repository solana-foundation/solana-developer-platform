#!/usr/bin/env bash
set -euo pipefail

KORA_RPC_URL="${KORA_RPC_URL:-https://your-kora-devnet-instance.us-central1.run.app}"

headers=(-H "Content-Type: application/json")
if [[ -n "${KORA_API_KEY:-}" ]]; then
  headers+=(-H "x-api-key: ${KORA_API_KEY}")
fi

echo "Checking Kora liveness..."
curl -fsS "${headers[@]}" "${KORA_RPC_URL}/liveness"
echo

echo "Checking Kora payer signer..."
curl -fsS "${headers[@]}" -X POST "${KORA_RPC_URL}" --data '{"jsonrpc":"2.0","id":1,"method":"getPayerSigner","params":[]}'
echo
