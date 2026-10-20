#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_SURFPOOL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-surfpool"}"
ENV_FILE="${STATE_DIR}/kora.env"
RUNTIME_ENV_FILE="${STATE_DIR}/runtime.env"
SURFPOOL_PID_FILE="${STATE_DIR}/surfpool.pid"
SURFPOOL_INFO_FILE="${STATE_DIR}/surfpool.json"
KORA_SHIM_PID_FILE="${STATE_DIR}/kora-shim.pid"
KORA_RPC_PROXY_PID_FILE="${STATE_DIR}/kora-rpc-proxy.pid"

compose_args=(-f "${ROOT_DIR}/infra/kora/docker-compose.yml")
if [ -f "${ENV_FILE}" ]; then
  compose_args=(--env-file "${ENV_FILE}" "${compose_args[@]}")
fi

if command -v docker >/dev/null 2>&1; then
  docker compose "${compose_args[@]}" down || true
fi

# A pid file can outlive its process (reboot, hard-closed terminal), so only
# signal a pid that is still one of ours: one of the harness scripts, or the CLI fork.
# The embedded fork leads its own process group, so the match stays exact.
for pid_file in "${KORA_RPC_PROXY_PID_FILE}" "${KORA_SHIM_PID_FILE}" "${SURFPOOL_PID_FILE}"; do
  if [ -f "${pid_file}" ]; then
    pid="$(cat "${pid_file}")"
    command_line="$(ps -o command= -p "${pid}" 2>/dev/null || true)"
    if [ -n "${pid}" ] && [[ "${command_line}" == *scripts/kora-surfpool-*.mjs* || "${command_line}" == *"surfpool start "* ]]; then
      kill -- -"${pid}" >/dev/null 2>&1 || kill "${pid}" >/dev/null 2>&1 || true
    fi
    rm -f "${pid_file}"
  fi
done

rm -f "${RUNTIME_ENV_FILE}" "${SURFPOOL_INFO_FILE}"

echo "Local Kora-on-Surfpool services stopped."
