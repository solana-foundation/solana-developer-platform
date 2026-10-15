#!/usr/bin/env bash
# `pnpm dev` plus both local paymasters. Runs under run-with-config.sh so Doppler
# dev supplies the RPC URLs and the funded devnet signer.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
trap '"${ROOT_DIR}/scripts/kora-local/down.sh"' EXIT

"${ROOT_DIR}/scripts/kora-local/up.sh"
turbo run dev dev:db dev:webhook --env-mode=loose
