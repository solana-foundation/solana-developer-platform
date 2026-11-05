#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/mask-secret-env.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

run_masked() {
  env -i PATH="$PATH" GITHUB_ACTIONS=true "$@" bash "$SCRIPT"
}

# Outside GitHub Actions it prints nothing.
out=$(env -i PATH="$PATH" CLERK_SECRET_KEY=sk_live_abcdef123456 bash "$SCRIPT")
[ -z "$out" ] || fail "printed outside GitHub Actions: $out"

out=$(run_masked \
  CLERK_SECRET_KEY=sk_live_abcdef123456 \
  API_KEY_PEPPER=pepper-value-123 \
  NEXT_PUBLIC_SDP_API_BASE_URL=https://api-preview.solana.com \
  DATABASE_URL=postgresql://sdp:hunter2hunter2@db.internal:5432/sdp \
  FEATURE_ENABLED=true \
  SHORT_TOKEN=abc \
  NODE_ENV=production)

grep -qxF '::add-mask::sk_live_abcdef123456' <<<"$out" || fail "secret-named value not masked"
grep -qxF '::add-mask::pepper-value-123' <<<"$out" || fail "pepper not masked"
grep -qxF '::add-mask::postgresql://sdp:hunter2hunter2@db.internal:5432/sdp' <<<"$out" ||
  fail "credentialed URL not masked"
grep -qF 'api-preview.solana.com' <<<"$out" && fail "plain URL was masked"
grep -qxF '::add-mask::production' <<<"$out" && fail "non-secret value was masked"
grep -qxF '::add-mask::true' <<<"$out" && fail "boolean was masked"
grep -qxF '::add-mask::abc' <<<"$out" && fail "short value was masked"

# Percent signs and carriage returns are escaped, so Actions decodes the
# command back to the exact value.
out=$(run_masked DATABASE_URL='postgresql://sdp:pass%25word@db.internal:5432/sdp')
grep -qxF '::add-mask::postgresql://sdp:pass%2525word@db.internal:5432/sdp' <<<"$out" ||
  fail "percent-encoded password not escaped: $out"
out=$(run_masked CLERK_SECRET_KEY=$'sk_live_abcdef\r123456')
grep -qxF '::add-mask::sk_live_abcdef%0D123456' <<<"$out" || fail "carriage return not escaped: $out"

# A multi-line secret (a PEM) is masked line by line.
pem=$'-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'
out=$(run_masked FIREBLOCKS_PRIVATE_KEY="$pem")
grep -qxF '::add-mask::MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' <<<"$out" || fail "PEM body line not masked"
grep -qxF '::add-mask::-----END PRIVATE KEY-----' <<<"$out" || fail "PEM footer not masked"

echo "mask-secret-env.test.sh: ok"
