#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_SURFPOOL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-surfpool"}"
ENV_FILE="${STATE_DIR}/kora.env"
RUNTIME_ENV_FILE="${STATE_DIR}/runtime.env"
SURFPOOL_PID_FILE="${STATE_DIR}/surfpool.pid"
SURFPOOL_INFO_FILE="${STATE_DIR}/surfpool.json"
KORA_SHIM_PID_FILE="${STATE_DIR}/kora-shim.pid"

compose_args=(-f "${ROOT_DIR}/infra/kora/docker-compose.yml")
if [ -f "${ENV_FILE}" ]; then
  compose_args=(--env-file "${ENV_FILE}" "${compose_args[@]}")
fi

if command -v docker >/dev/null 2>&1; then
  docker compose "${compose_args[@]}" down || true
fi

if [ -f "${KORA_SHIM_PID_FILE}" ]; then
  pid="$(cat "${KORA_SHIM_PID_FILE}")"
  if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill -- -"${pid}" >/dev/null 2>&1 || kill "${pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${KORA_SHIM_PID_FILE}"
fi

if [ -f "${SURFPOOL_PID_FILE}" ]; then
  pid="$(cat "${SURFPOOL_PID_FILE}")"
  if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill -- -"${pid}" >/dev/null 2>&1 || kill "${pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${SURFPOOL_PID_FILE}"
fi

rm -f "${RUNTIME_ENV_FILE}" "${SURFPOOL_INFO_FILE}"

echo "Local Kora-on-Surfpool services stopped."
