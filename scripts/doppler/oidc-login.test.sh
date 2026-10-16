#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/oidc-login.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"

cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
count=$(($(cat "$STUB_STATE/curl.count") + 1))
echo "$count" > "$STUB_STATE/curl.count"
echo "$*" >> "$STUB_STATE/curl.log"
for failing in $CURL_FAIL_CALLS; do
  if [ "$failing" = "$count" ]; then
    exit 22
  fi
done
printf '{"value":"jwt-%s"}\n' "$count"
STUB

cat > "$TMP/bin/doppler" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
count=$(($(cat "$STUB_STATE/doppler.count") + 1))
echo "$count" > "$STUB_STATE/doppler.count"
echo "$*" >> "$STUB_STATE/doppler.log"
for failing in $DOPPLER_FAIL_CALLS; do
  if [ "$failing" = "$count" ]; then
    exit 1
  fi
done
STUB

cat > "$TMP/bin/sleep" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$STUB_STATE/sleep.log"
STUB

chmod +x "$TMP/bin/curl" "$TMP/bin/doppler" "$TMP/bin/sleep"

export PATH="$TMP/bin:$PATH"
export STUB_STATE="$TMP"
export ACTIONS_ID_TOKEN_REQUEST_TOKEN="request-token-fixture"
export ACTIONS_ID_TOKEN_REQUEST_URL="https://token.invalid/?x=1"

reset_stubs() {
  echo 0 > "$TMP/curl.count"
  echo 0 > "$TMP/doppler.count"
  : > "$TMP/curl.log"
  : > "$TMP/doppler.log"
  : > "$TMP/sleep.log"
  : > "$TMP/stderr"
}

run_login() {
  if bash "$SCRIPT" identity-fixture 2> "$TMP/stderr"; then
    status=0
  else
    status=$?
  fi
}

line_count() {
  wc -l < "$1" | tr -d ' '
}

expect_equal() {
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: expected '$2', got '$3'" >&2
    exit 1
  fi
}

reset_stubs
export CURL_FAIL_CALLS=""
export DOPPLER_FAIL_CALLS=""
run_login
expect_equal "first attempt succeeds: exit status" "0" "$status"
expect_equal "first attempt succeeds: curl calls" "1" "$(line_count "$TMP/curl.log")"
expect_equal "first attempt succeeds: doppler calls" \
  "oidc login --scope=. --identity=identity-fixture --token=jwt-1" \
  "$(cat "$TMP/doppler.log")"
expect_equal "first attempt succeeds: sleep calls" "" "$(cat "$TMP/sleep.log")"

reset_stubs
export CURL_FAIL_CALLS="1"
export DOPPLER_FAIL_CALLS=""
run_login
expect_equal "token request retried: exit status" "0" "$status"
expect_equal "token request retried: curl calls" "2" "$(line_count "$TMP/curl.log")"
expect_equal "token request retried: doppler calls" \
  "oidc login --scope=. --identity=identity-fixture --token=jwt-2" \
  "$(cat "$TMP/doppler.log")"
expect_equal "token request retried: sleep calls" "5" "$(cat "$TMP/sleep.log")"

reset_stubs
export CURL_FAIL_CALLS=""
export DOPPLER_FAIL_CALLS="1"
run_login
expect_equal "doppler login retried: exit status" "0" "$status"
expect_equal "doppler login retried: doppler calls" \
  "oidc login --scope=. --identity=identity-fixture --token=jwt-1
oidc login --scope=. --identity=identity-fixture --token=jwt-2" \
  "$(cat "$TMP/doppler.log")"
expect_equal "doppler login retried: sleep calls" "5" "$(cat "$TMP/sleep.log")"

reset_stubs
export CURL_FAIL_CALLS=""
export DOPPLER_FAIL_CALLS="1 2 3"
run_login
expect_equal "all attempts fail: exit status" "1" "$status"
expect_equal "all attempts fail: curl calls" "3" "$(line_count "$TMP/curl.log")"
expect_equal "all attempts fail: doppler calls" "3" "$(line_count "$TMP/doppler.log")"
expect_equal "all attempts fail: sleep calls" "5
10" "$(cat "$TMP/sleep.log")"
if ! grep -q "failed after 3 attempts" "$TMP/stderr"; then
  echo "FAIL: all attempts fail: stderr missing 'failed after 3 attempts', got: '$(cat "$TMP/stderr")'" >&2
  exit 1
fi

echo "OK: Doppler OIDC login retries covered"
