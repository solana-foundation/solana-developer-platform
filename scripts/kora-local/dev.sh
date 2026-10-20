#!/usr/bin/env bash
# `pnpm dev`: both local paymasters, then the turbo dev stack. Runs under
# run-with-config.sh so Doppler dev supplies the RPC URLs and the funded devnet
# signer. Kora boots first because the API and worker launchers read
# .secrets/kora-local/api.env once, at start.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
trap '"${ROOT_DIR}/scripts/kora-local/down.sh"' EXIT

"${ROOT_DIR}/scripts/kora-local/up.sh"
turbo run dev dev:worker dev:db dev:webhook --env-mode=loose --continue=always
