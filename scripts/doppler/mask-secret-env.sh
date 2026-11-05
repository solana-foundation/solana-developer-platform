#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/doppler/mask-secret-env.sh
# Registers secret-shaped environment values with GitHub Actions log masking.
# `doppler run` injects secrets as plain environment variables, which GitHub
# only masks for its own `secrets.*` context, so a step that prints its config
# would publish them in this public repository's logs. Masked: any variable
# whose name looks like a credential, and any value that is a URL carrying a
# password. Multi-line values are masked line by line. Lines shorter than six
# characters are skipped so that values like `true` or `1` never blank out
# ordinary log text. Outside GitHub Actions this prints nothing.

if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  exit 0
fi

secret_name='(SECRET|TOKEN|PASSWORD|PASSWD|PEPPER|PRIVATE|CREDENTIAL|WEBHOOK|SIGNING|DSN|API_KEY|_KEY$|_KEY_|^KEY$)'
credentialed_url='://[^/@[:space:]]+:[^@[:space:]]+@'
min_length=6

while IFS= read -r -d '' entry; do
  name="${entry%%=*}"
  value="${entry#*=}"
  if [ -z "$value" ]; then
    continue
  fi
  if [[ "$name" =~ $secret_name ]] || [[ "$value" =~ $credentialed_url ]]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "${#line}" -ge "$min_length" ]; then
        printf '::add-mask::%s\n' "$line"
      fi
    done <<<"$value"
  fi
done < <(env -0)
