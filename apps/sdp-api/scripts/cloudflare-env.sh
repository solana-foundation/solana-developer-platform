#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $(basename "$0") <dev|production> <pnpm-script>" >&2
  echo "Example: $(basename "$0") dev deploy:dev" >&2
  exit 1
fi

target="$1"
shift

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${app_dir}/../.." && pwd)"

if ! command -v doppler >/dev/null 2>&1; then
  echo "Doppler CLI is required. Install it first, then rerun this command." >&2
  exit 1
fi

if [[ "${target}" != "dev" && "${target}" != "production" ]]; then
  echo "Unsupported target '${target}'. Use dev or production, or override DOPPLER_CONFIG explicitly." >&2
  exit 1
fi

default_config="${target}"
if [[ "${target}" == "production" ]]; then
  default_config="prd"
fi

config="${DOPPLER_CONFIG:-${default_config}}"

exec doppler run --config "${config}" -- pnpm --dir "${repo_root}" --filter @sdp/api run "$@"
