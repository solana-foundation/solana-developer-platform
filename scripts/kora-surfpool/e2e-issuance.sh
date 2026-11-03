#!/usr/bin/env bash
# Usage: e2e-issuance.sh  — runs the Issuance browser E2E spec against Surfpool.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running issuance E2E against Surfpool"
cd "${ROOT_DIR}"
pnpm kora:surfpool:run -- \
  pnpm --filter sdp-web exec playwright test \
    --config=playwright.config.ts \
    --project=issuance \
    playwright/tests/issuance.e2e.spec.ts
