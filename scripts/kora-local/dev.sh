#!/usr/bin/env bash
# `pnpm dev`: both local paymasters, then the turbo dev stack. Runs under
# run-with-config.sh so Doppler dev supplies the RPC URLs. Kora boots first because
# the API and worker launchers read .secrets/kora-local/api.env once, at start.
# Both Koras and the mainnet Kora's Surfpool fork outlive this run, like Postgres and
# Redis: every worktree shares them, so one worktree exiting must not stop another's
# paymaster. Stop them with `pnpm kora:local:down`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
URLS_FILE="${ROOT_DIR}/.secrets/dev-urls.env"

# Doppler dev names the deployed dev data stores. Local dev uses the ones apps/sdp-api/.env.local
# names, else the local Docker Postgres and Redis (apps/sdp-api/scripts/lib/dev-env.mjs), so a
# fresh worktree never reaches, or migrates, a shared remote database.
unset DATABASE_URL REDIS_URL

# One port slot per running `pnpm dev`, so worktrees run side by side: slot N moves the
# API, worker, web and docs ports up by 10*N, and the first slot whose four ports are all
# free wins. These exports are the run's only port source: they beat every .env.local
# (Next keeps a variable the process already has; dev-env.mjs reads SDP_API_PORT from the
# process first), so each service binds where its URLs point.
# ponytail: two runs starting in the same second can pick one slot; the loser's API fails
# to bind and a rerun takes the next slot.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || (exec 3<>"/dev/tcp/::1/$1") 2>/dev/null; }
offset=""
for slot in $(seq 0 9); do
  candidate=$((slot * 10))
  if ! port_in_use $((8787 + candidate)) && ! port_in_use $((8789 + candidate)) &&
    ! port_in_use $((3000 + candidate)) && ! port_in_use $((3001 + candidate)); then
    offset="${candidate}"
    break
  fi
done
[ -n "${offset}" ] || { echo "No free dev port slot: 10 pnpm dev runs already hold 8787-8877 / 3000-3091." >&2; exit 1; }

export SDP_API_PORT=$((8787 + offset))
export SDP_WORKER_PORT=$((8789 + offset))
export PORT=$((3000 + offset))
export SDP_DOCS_PORT=$((3001 + offset))
export SDP_API_BASE_URL="http://127.0.0.1:${SDP_API_PORT}"
export NEXT_PUBLIC_SDP_API_BASE_URL="${SDP_API_BASE_URL}"
export PUBLIC_API_ORIGIN="http://localhost:${SDP_API_PORT}"
export NEXT_PUBLIC_SDP_WEB_URL="http://localhost:${PORT}/"
export SDP_DOCS_PROXY_ORIGIN="http://localhost:${SDP_DOCS_PORT}"
# The dashboard's absolute docs links: a pinned value (the deployed docs) stays; otherwise this slot.
export NEXT_PUBLIC_SDP_DOCS_URL="${NEXT_PUBLIC_SDP_DOCS_URL:-http://localhost:${PORT}/docs}"

mkdir -p "$(dirname "${URLS_FILE}")"
{
  echo "WEB_URL=http://localhost:${PORT}"
  echo "API_URL=${SDP_API_BASE_URL}"
  echo "DOCS_URL=${SDP_DOCS_PROXY_ORIGIN}"
} >"${URLS_FILE}"

"${ROOT_DIR}/scripts/kora-local/up.sh"
echo "This worktree: web http://localhost:${PORT}  API ${SDP_API_BASE_URL}  docs ${SDP_DOCS_PROXY_ORIGIN} (also in ${URLS_FILE#"${ROOT_DIR}"/})."
turbo run dev dev:worker dev:db dev:webhook dev:kora --env-mode=loose --continue=always
