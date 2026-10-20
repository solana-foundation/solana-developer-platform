#!/usr/bin/env bash
# `pnpm dev`: both local paymasters, then the turbo dev stack. Runs under
# run-with-config.sh so Doppler dev supplies the RPC URLs. Kora boots first because
# the API and worker launchers read .secrets/kora-local/api.env once, at start.
# Both Koras and the mainnet Kora's Surfpool fork outlive this run, like Postgres and
# Redis: every worktree shares them, so one worktree exiting must not stop another's
# paymaster. Stop them with `pnpm kora:local:down`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"${ROOT_DIR}/scripts/kora-local/up.sh"
turbo run dev dev:worker dev:db dev:webhook --env-mode=loose --continue=always
