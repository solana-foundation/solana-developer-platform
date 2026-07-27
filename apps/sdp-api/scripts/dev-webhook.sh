#!/usr/bin/env bash
set -euo pipefail

port="${SDP_API_PORT:-8787}"

if [ -t 2 ]; then
  bold=$'\033[1m' dim=$'\033[2m' yellow=$'\033[33m' cyan=$'\033[36m' reset=$'\033[0m'
else
  bold="" dim="" yellow="" cyan="" reset=""
fi

if ! command -v ngrok >/dev/null 2>&1; then
  echo "${yellow}ngrok is not installed${reset} — skipping the webhook tunnel." >&2
  echo "Provider webhooks (Clerk, ramps) need a public URL to reach your local API. Install ngrok to enable it: ${cyan}brew install ngrok${reset} (https://ngrok.com/download)" >&2
  exit 0
fi

if [ -n "${WEBHOOK_INGEST_DOMAIN:-}" ]; then
  base_url="https://${WEBHOOK_INGEST_DOMAIN}"
  echo "Tunneling ${cyan}${base_url}${reset} -> http://127.0.0.1:${port}" >&2
else
  base_url="https://<assigned-by-ngrok>"
  echo "${yellow}No WEBHOOK_INGEST_DOMAIN set${reset} — ngrok will assign a random URL each run." >&2
  echo "Reserve a free stable domain at https://dashboard.ngrok.com/domains and set ${cyan}WEBHOOK_INGEST_DOMAIN${reset} in apps/sdp-api/.env.local." >&2
fi

echo "${dim}Register provider webhooks against:${reset}" >&2
echo "${dim}  Clerk  ${base_url}/webhooks/clerk/link-orgs${reset}" >&2
echo "${dim}  Ramps  ${base_url}/webhooks/payments/ramps/sandbox/<provider>${reset}" >&2

exec ngrok http ${WEBHOOK_INGEST_DOMAIN:+--url="${WEBHOOK_INGEST_DOMAIN}"} "${port}"
