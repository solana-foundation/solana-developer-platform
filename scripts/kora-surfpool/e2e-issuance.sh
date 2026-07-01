#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_PERSIST_PATH="${PLAYWRIGHT_API_PERSIST_PATH:-.wrangler/state-playwright}"

run_shard() {
  local name="$1"
  local grep="$2"
  local suffix="$3"

  echo "Running issuance E2E Surfpool shard: ${name}"
  (
    cd "${ROOT_DIR}"
    PLAYWRIGHT_API_PERSIST_PATH="${BASE_PERSIST_PATH}-${suffix}" \
      pnpm kora:surfpool:run -- \
      pnpm --filter sdp-web exec playwright test \
        --config=playwright.config.ts \
        --project=issuance \
        playwright/tests/issuance.e2e.spec.ts \
        -g "${grep}"
  )
}

run_shard "basics" "\\b(1|2|3|4|5)\\. user" "issuance-basics"
run_shard "authority and supply" "\\b(7|9)\\. user" "issuance-authority-supply"
run_shard "freeze controls" "\\b(8|10|11|12)\\. user" "issuance-freeze"
run_shard "pause controls" "\\b13\\. user" "issuance-pause"
run_shard "allowlist" "\\b6\\. user" "issuance-allowlist"
