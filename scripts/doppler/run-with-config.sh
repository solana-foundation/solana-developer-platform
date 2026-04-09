#!/usr/bin/env bash
set -euo pipefail

if [ "${DOPPLER_RUN_ACTIVE:-}" = "1" ]; then
  exec "$@"
fi

if ! command -v doppler >/dev/null 2>&1; then
  echo "Doppler CLI is required. Install it first, then rerun this command." >&2
  exit 1
fi

config="${DOPPLER_CONFIG:-dev}"

exec doppler run --config "${config}" -- env DOPPLER_RUN_ACTIVE=1 DOPPLER_CONFIG="${config}" "$@"
