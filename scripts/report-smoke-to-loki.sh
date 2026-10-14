#!/usr/bin/env bash
set -euo pipefail

SMOKE_OUTCOME="${SMOKE_OUTCOME:?SMOKE_OUTCOME required}"
SMOKE_TARGET="${SMOKE_TARGET:-dev}"
RUN_ID="${RUN_ID:-}"
RUN_URL="${RUN_URL:-}"

TS="$(date +%s)000000000"
LINE=$(jq -cn --arg outcome "$SMOKE_OUTCOME" --arg run_id "$RUN_ID" --arg run_url "$RUN_URL" \
  '{event: "sdp_smoke_run", outcome: $outcome, failed_any: ($outcome != "success"), run_id: $run_id, run_url: $run_url}')
PAYLOAD=$(jq -cn --arg ts "$TS" --arg line "$LINE" --arg target "$SMOKE_TARGET" \
  '{streams: [{stream: {service: "sdp-smoke", tenant: "sdp", env: $target, target: $target}, values: [[$ts, $line]]}]}')

curl -fsS --connect-timeout 5 --max-time 15 -u "${SF_LOKI_USER:?SF_LOKI_USER required}:${SF_LOKI_TOKEN:?SF_LOKI_TOKEN required}" -H "Content-Type: application/json" \
  -d "$PAYLOAD" "${SF_LOKI_PUSH_URL:?SF_LOKI_PUSH_URL required}"
