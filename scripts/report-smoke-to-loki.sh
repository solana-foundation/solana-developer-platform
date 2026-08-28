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

curl -fsS -u "${GC_LOKI_USER}:${GC_LOKI_TOKEN}" -H "Content-Type: application/json" \
  -d "$PAYLOAD" "$GC_LOKI_PUSH_URL"
