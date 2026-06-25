#!/usr/bin/env bash
# Generic deploy/result notifier for the Slack deploy webhook — reusable by any service's CI.
# Reads the webhook from Doppler (SLACK_DEPLOY_WEBHOOK_URL).
#
# Required env: SERVICE, STATUS (started|success|failure/<other>), DOPPLER_PROJECT, DOPPLER_CONFIG, DOPPLER_TOKEN
# Optional env: ENV (e.g. mainnet/devnet), VERSION (tag/sha), ACTOR, RUN_URL, RUN_ID
set -euo pipefail

SERVICE="${SERVICE:?SERVICE required}"
STATUS="${STATUS:?STATUS required}"
ENV="${ENV:-}"; VERSION="${VERSION:-}"; ACTOR="${ACTOR:-unknown}"
RUN_URL="${RUN_URL:-}"; RUN_ID="${RUN_ID:-}"

SLACK=$(doppler secrets get SLACK_DEPLOY_WEBHOOK_URL --plain --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" 2>/dev/null || true)
if [ -z "$SLACK" ]; then echo "::warning::SLACK_DEPLOY_WEBHOOK_URL missing — skipping notification"; exit 0; fi
echo "::add-mask::$SLACK"

LABEL="$SERVICE"; [ -n "$ENV" ] && LABEL="$SERVICE ($ENV)"
case "$STATUS" in
  started) MARKER="[STARTED] Deploy $LABEL"; COLOR="#dbab09" ;;
  success) MARKER="[SUCCESS] Deploy $LABEL"; COLOR="#36a64f" ;;
  *)       MARKER="[FAILED] Deploy $LABEL";  COLOR="#cc0000" ;;
esac

FIELDS=$(jq -n --arg label "$LABEL" --arg ver "$VERSION" --arg actor "$ACTOR" --arg run "$RUN_URL" --arg rid "$RUN_ID" \
  '[ {type:"mrkdwn",text:("*Service:*\n`"+$label+"`")} ]
    + (if $ver != "" then [ {type:"mrkdwn",text:("*Version:*\n`"+$ver+"`")} ] else [] end)
    + [ {type:"mrkdwn",text:("*Triggered by:*\n"+$actor)} ]
    + (if $run != "" then [ {type:"mrkdwn",text:("*Run:*\n<"+$run+"|workflow #"+$rid+">")} ] else [] end)')
PAYLOAD=$(jq -n --arg marker "$MARKER" --arg color "$COLOR" --argjson fields "$FIELDS" \
  '{ text: ("*"+$marker+"*"),
     attachments: [ { color:$color, blocks:[
       {type:"section", text:{type:"mrkdwn", text:("*"+$marker+"*")}},
       {type:"section", fields:$fields} ] } ] }')
curl -sS --fail-with-body -X POST -H 'Content-Type: application/json' --data "$PAYLOAD" "$SLACK"
