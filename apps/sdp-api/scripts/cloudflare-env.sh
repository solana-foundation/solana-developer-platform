#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $(basename "$0") <dev|qa|production> <pnpm-script>" >&2
  echo "Example: $(basename "$0") dev deploy:dev" >&2
  exit 1
fi

target="$1"
shift

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"

env_file="${app_dir}/.cloudflare.${target}.env"
example_file="${env_file}.example"

if [[ ! -f "${env_file}" ]]; then
  echo "Missing ${env_file}." >&2
  echo "Create it from ${example_file} and add your Cloudflare credentials." >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "${env_file}"
set +a

pnpm --filter @sdp/api run "$@"
