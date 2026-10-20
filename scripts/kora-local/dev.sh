#!/usr/bin/env bash
# `pnpm dev`: both local paymasters, then the turbo dev stack. Runs under
# run-with-config.sh so Doppler dev supplies the RPC URLs. Kora boots first because
# the API and worker launchers read .secrets/kora-local/api.env once, at start.
# Kora outlives this run, like Postgres and Redis: every worktree shares the same
# containers, so one worktree exiting must not stop another's paymaster. Stop it with
# `pnpm kora:local:down`. This worktree's Surfpool fork is a host process, so exit stops it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_LOCAL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-local"}"

stop_own_surfpool() {
  local pid_file pid
  for pid_file in "${STATE_DIR}"/mainnet/*.pid; do
    [ -f "${pid_file}" ] || continue
    pid="$(cat "${pid_file}")"
    # A pid file can outlive its process, so only signal a pid that is still a Surfpool one.
    if [ -n "${pid}" ] && [[ "$(ps -o command= -p "${pid}" 2>/dev/null)" == *surfpool* ]]; then
      kill "${pid}" 2>/dev/null || true
    fi
    rm -f "${pid_file}"
  done
}
trap stop_own_surfpool EXIT

"${ROOT_DIR}/scripts/kora-local/up.sh"
turbo run dev dev:worker dev:db dev:webhook --env-mode=loose --continue=always
