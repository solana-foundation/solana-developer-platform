#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_SURFPOOL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-surfpool"}"
RUNTIME_ENV_FILE="${STATE_DIR}/runtime.env"

if [ "${1:-}" = "--" ]; then
  shift
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: pnpm kora:surfpool:integration -- <test-files...>" >&2
  exit 1
fi

configure_local_custody() {
  if [ "${SDP_INTEGRATION_CUSTODY_PROVIDER}" != "local" ]; then
    return
  fi

  export SIGNING_PROVIDER=local
  export SIGNING_PROVIDERS=local

  if [ -n "${KORA_SURFPOOL_CUSTODY_PRIVATE_KEY:-}" ]; then
    export CUSTODY_PRIVATE_KEY="${KORA_SURFPOOL_CUSTODY_PRIVATE_KEY}"
  elif [ -z "${CUSTODY_PRIVATE_KEY:-}" ]; then
    echo "Generating test-only local custody signer."
    CUSTODY_PRIVATE_KEY="$(pnpm --silent --filter @sdp/api keygen:local --quiet)"
    export CUSTODY_PRIVATE_KEY
  fi
}

test_files=()
vitest_args=()
for arg in "$@"; do
  case "${arg}" in
    *.test.ts | *.spec.ts)
      test_files+=("${arg}")
      ;;
    *)
      vitest_args+=("${arg}")
      ;;
  esac
done

if [ "${KORA_SURFPOOL_SINGLE_FILE_RUN:-}" != "1" ] && [ "${#test_files[@]}" -gt 1 ]; then
  for test_file in "${test_files[@]}"; do
    echo "Running Surfpool integration file with fresh harness: ${test_file}"
    if [ "${#vitest_args[@]}" -eq 0 ]; then
      KORA_SURFPOOL_SINGLE_FILE_RUN=1 "${ROOT_DIR}/scripts/kora-surfpool/integration.sh" -- "${test_file}"
    else
      KORA_SURFPOOL_SINGLE_FILE_RUN=1 "${ROOT_DIR}/scripts/kora-surfpool/integration.sh" -- "${vitest_args[@]}" "${test_file}"
    fi
  done
  exit 0
fi

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
export SOLANA_RPC_DEFAULT_PROVIDER=default
export SDP_INTEGRATION_CUSTODY_PROVIDER="${SDP_INTEGRATION_CUSTODY_PROVIDER:-local}"
configure_local_custody
export DATABASE_URL="${KORA_SURFPOOL_DATABASE_URL:-postgresql://sdp:sdp@127.0.0.1:5432/sdp}"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="${DATABASE_URL}"

"${ROOT_DIR}/scripts/kora-surfpool/up.sh"
if [ -f "${RUNTIME_ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${RUNTIME_ENV_FILE}"
  set +a
fi

# Re-derive DB bindings after runtime.env is sourced; up.sh may write a
# KORA_SURFPOOL_DATABASE_URL override for the active harness.
export SOLANA_RPC_DEFAULT_PROVIDER=default
export DATABASE_URL="${KORA_SURFPOOL_DATABASE_URL:-postgresql://sdp:sdp@127.0.0.1:5432/sdp}"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="${DATABASE_URL}"

pnpm --filter @sdp/api db:postgres:bootstrap

pnpm --filter @sdp/api-integration exec vitest run --no-file-parallelism --hookTimeout 240000 "$@"
