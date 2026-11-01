#!/usr/bin/env bash
# Starts the app, hits each endpoint, prints status + body, then stops it.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

PORT="${PORT:-8080}"
BASE="http://127.0.0.1:${PORT}"

python3 app.py > /tmp/sdp-metrics-api-manual-test.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

echo "Waiting for server (pid $SERVER_PID) on port $PORT..."
for _ in $(seq 1 30); do
    if curl -s -o /dev/null "$BASE/healthz"; then
        break
    fi
    sleep 0.5
done

check() {
    local method="GET" path="$1"
    echo
    echo "=== $path ==="
    local resp status body
    resp=$(curl -s -w '\n%{http_code}' "$BASE$path")
    status=$(echo "$resp" | tail -n1)
    body=$(echo "$resp" | sed '$d')
    echo "status: $status"
    echo "body: $body"
}

check "/healthz"
check "/rpc/series?days=1"
check "/rpc?days=1"
