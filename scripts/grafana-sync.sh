#!/usr/bin/env bash
# Sync dashboards, alert rules, contact points, and the notification policy to Grafana Cloud.
# Run under `doppler run` so creds come from env:
#   required: GRAFANA_API_URL, GRAFANA_API_TOKEN, GRAFANA_FOLDER_UID
#   optional: PAGERDUTY_INTEGRATION_KEY, SLACK_ALERT_WEBHOOK_URL (contact points + policy skipped if unset)
set -euo pipefail

: "${GRAFANA_API_URL:?}"
: "${GRAFANA_API_TOKEN:?}"
: "${GRAFANA_FOLDER_UID:?}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."
AUTH=(-H "Authorization: Bearer $GRAFANA_API_TOKEN")
PROV=(-H 'Content-Type: application/json' -H 'X-Disable-Provenance: true')
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"
shopt -s nullglob

check() { # http_code label
  if [ "$1" -ge 300 ]; then echo "::error::$2 failed ($1)"; cat /tmp/resp.json; exit 1; fi
}

for f in dashboards/*.json; do
  payload=$(jq --arg folder "$GRAFANA_FOLDER_UID" --arg msg "Pushed from $SHA" \
    '{dashboard: ., folderUid: $folder, overwrite: true, message: $msg}' "$f")
  code=$(curl -sS -o /tmp/resp.json -w '%{http_code}' -X POST "$GRAFANA_API_URL/api/dashboards/db" \
    "${AUTH[@]}" -H 'Content-Type: application/json' --data "$payload")
  check "$code" "dashboard $(basename "$f")"; echo "dashboard $(basename "$f"): $code"
done

for f in alert-rules/*.json; do
  uid=$(jq -r '.uid // empty' "$f")
  [ -z "$uid" ] && { echo "::error file=$f::missing top-level .uid"; exit 1; }
  code=$(curl -sS -o /tmp/resp.json -w '%{http_code}' -X PUT "$GRAFANA_API_URL/api/v1/provisioning/alert-rules/$uid" "${AUTH[@]}" "${PROV[@]}" --data "@$f")
  [ "$code" = "404" ] && code=$(curl -sS -o /tmp/resp.json -w '%{http_code}' -X POST "$GRAFANA_API_URL/api/v1/provisioning/alert-rules" "${AUTH[@]}" "${PROV[@]}" --data "@$f")
  check "$code" "alert $uid"; echo "alert $uid: $code"
done

if [ -z "${PAGERDUTY_INTEGRATION_KEY:-}" ] || [ -z "${SLACK_ALERT_WEBHOOK_URL:-}" ]; then
  echo "PD/Slack secrets not set — skipping contact points + policy"; exit 0
fi

existing=$(curl -sS "$GRAFANA_API_URL/api/v1/provisioning/contact-points" "${AUTH[@]}")
for f in notification-policies/contact-points/*.json; do
  name=$(jq -r '.name' "$f")
  payload=$(python3 -c 'import os,sys; sys.stdout.write(os.path.expandvars(sys.stdin.read()))' < "$f")
  uid=$(jq -r --arg n "$name" '.[] | select(.name == $n) | .uid // empty' <<<"$existing" | head -1)
  if [ -n "$uid" ]; then
    code=$(curl -sS -o /tmp/resp.json -w '%{http_code}' -X PUT "$GRAFANA_API_URL/api/v1/provisioning/contact-points/$uid" "${AUTH[@]}" "${PROV[@]}" --data "$payload")
  else
    code=$(curl -sS -o /tmp/resp.json -w '%{http_code}' -X POST "$GRAFANA_API_URL/api/v1/provisioning/contact-points" "${AUTH[@]}" "${PROV[@]}" --data "$payload")
  fi
  check "$code" "contact-point $name"; echo "contact-point $name: $code"
done

if [ -f notification-policies/policy.json ]; then
  code=$(curl -sS -o /tmp/resp.json -w '%{http_code}' -X PUT "$GRAFANA_API_URL/api/v1/provisioning/policies" "${AUTH[@]}" "${PROV[@]}" --data "@notification-policies/policy.json")
  check "$code" "policy"; echo "policy: $code"
fi
