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
preserve_env="${DOPPLER_PRESERVE_ENV:-DATABASE_URL,CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,SDP_API_BASE_URL,NEXT_PUBLIC_SDP_API_BASE_URL,NEXT_PUBLIC_SDP_API_URL,SDP_API_LOCAL_PERSIST_PATH,SDP_API_PORT,SDP_API_RESET_LOCAL_STATE,PLAYWRIGHT_API_URL,PLAYWRIGHT_API_PORT,PLAYWRIGHT_API_PERSIST_PATH,PLAYWRIGHT_BASE_URL,PLAYWRIGHT_NEXT_DIST_DIR,PLAYWRIGHT_USE_NEXT_START}"

exec doppler run --config "${config}" --preserve-env="${preserve_env}" -- env DOPPLER_RUN_ACTIVE=1 DOPPLER_CONFIG="${config}" "$@"
