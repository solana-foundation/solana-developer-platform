#!/usr/bin/env bash
set -euo pipefail

KORA_RPC_URL="${KORA_RPC_URL:-https://kora-sdp-p3bno75vpa-uc.a.run.app}"

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

echo "Checking Kora sRFC-37 allowed programs..."
config_response="$(curl -fsS "${headers[@]}" -X POST "${KORA_RPC_URL}" --data '{"jsonrpc":"2.0","id":2,"method":"getConfig","params":[]}')"
KORA_CONFIG_RESPONSE="${config_response}" node <<'NODE'
const requiredPrograms = [
  "TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP",
  "GATEzzqxhJnsWF6vHRsgtixxSB8PaQdcqGEVTEHWiULz",
];

const response = JSON.parse(process.env.KORA_CONFIG_RESPONSE ?? "{}");
if (response.error) {
  console.error(`Kora getConfig failed: ${response.error.message ?? JSON.stringify(response.error)}`);
  process.exit(1);
}

const allowedPrograms = response.result?.validation_config?.allowed_programs ?? [];

const missingPrograms = requiredPrograms.filter((program) => !allowedPrograms.includes(program));
if (missingPrograms.length > 0) {
  console.error(`Missing Kora allowed programs: ${missingPrograms.join(", ")}`);
  process.exit(1);
}

console.log(`Kora allows required sRFC-37 programs: ${requiredPrograms.join(", ")}`);
NODE
