#!/usr/bin/env bash
# Usage: e2e-issuance.sh [group]  — one group key, or every group in order when omitted.
# The five groups run issuance.e2e.spec.ts on the previous Issuance design; "redesign" runs
# issuance-redesign.e2e.spec.ts and needs SDP_FLAG_NEW_DESIGN_ISSUANCE=true, so it is only run
# by name.
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
    redesign) echo "\\bR[0-9]+\\. user" ;;
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

  local spec="playwright/tests/issuance.e2e.spec.ts"
  if [ "${name}" = "redesign" ]; then
    spec="playwright/tests/issuance-redesign.e2e.spec.ts"
  fi

  echo "Running issuance E2E Surfpool shard: ${name}"
  (
    cd "${ROOT_DIR}"
    pnpm kora:surfpool:run -- \
      pnpm --filter sdp-web exec playwright test \
        --config=playwright.config.ts \
        --project=issuance \
        "${spec}" \
        -g "${grep}"
  )
}

if [ "$#" -eq 0 ]; then
  for group in ${ALL_GROUPS}; do run_shard "${group}"; done
else
  run_shard "$1"
fi
