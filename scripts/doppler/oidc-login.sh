#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/doppler/oidc-login.sh <doppler-identity-id>
# Requests a fresh GitHub OIDC token and exchanges it with Doppler, retrying transient
# api.doppler.com failures (e.g. "ContentLength=… with Body length 0") a bounded number of times.
identity="${1:?usage: oidc-login.sh <doppler-identity-id>}"
attempts=3

for attempt in $(seq 1 "$attempts"); do
  if oidc_jwt=$(curl -sf -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=https://github.com/solana-foundation" | jq -r '.value') &&
    doppler oidc login --scope=. --identity="${identity}" --token="${oidc_jwt}"; then
    exit 0
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    delay=$((attempt * 5))
    echo "Doppler OIDC login attempt ${attempt}/${attempts} failed; retrying in ${delay}s" >&2
    sleep "$delay"
  fi
done

echo "Doppler OIDC login failed after ${attempts} attempts" >&2
exit 1
