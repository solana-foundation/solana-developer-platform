#!/usr/bin/env bash
# Usage: e2e-issuance.sh [group]  — one group key, or every group in order when omitted.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALL_GROUPS="basics authority-and-supply freeze-controls pause-controls allowlist"

group_pattern() {
  case "$1" in
    basics) echo "\\b(1|2|3|4|5)\\. user" ;;
    authority-and-supply) echo "\\b(7|9)\\. user" ;;
    freeze-controls) echo "\\b(8|10|11|12)\\. user" ;;
    pause-controls) echo "\\b13\\. user" ;;
    allowlist) echo "\\b6\\. user" ;;
    *)
      echo "Unknown issuance E2E group: $1" >&2
      echo "Valid groups: ${ALL_GROUPS}" >&2
      exit 2
      ;;
  esac
}

run_shard() {
  local name="$1"
  local grep
  grep="$(group_pattern "${name}")"

  echo "Running issuance E2E Surfpool shard: ${name}"
  (
    cd "${ROOT_DIR}"
    pnpm kora:surfpool:run -- \
      pnpm --filter sdp-web exec playwright test \
        --config=playwright.config.ts \
        --project=issuance \
        playwright/tests/issuance.e2e.spec.ts \
        -g "${grep}"
  )
}

if [ "$#" -eq 0 ]; then
  for group in ${ALL_GROUPS}; do run_shard "${group}"; done
else
  run_shard "$1"
fi
