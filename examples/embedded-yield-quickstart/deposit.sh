#!/usr/bin/env bash
# The Embedded Yield quickstart's cURL path: the same requests as deposit.ts, in order.
# Embedded Yield, not Treasury: the wallet that signs is a customer's own, and
# test-wallet.json stands in for it.
# Needs curl, jq, Node.js and solana-keygen. Run it from this folder.
set -euo pipefail

: "${SDP_API_KEY:?Set SDP_API_KEY to an API key with Earn Execute}"
# The hosted sandbox by default. Set SDP_API_URL to use another API.
SDP_API_URL="${SDP_API_URL:-https://api-beta.solana.com}"
WALLET="$(solana-keygen pubkey test-wallet.json)"

# Fetch the strategies, and take one that is open for deposits, takes devnet USDC,
# and needs no slippage floor.
export STRATEGY_ID="$(curl -sS "$SDP_API_URL/v1/earn/strategies?pageSize=100" \
  -H "Authorization: Bearer $SDP_API_KEY" | jq -r '
    [.data.strategies[] | select(.fundable and .status == "active" and .depositSlippage == null
      and .depositMints[0] == "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")][0].id')"
echo "$STRATEGY_ID" # "null" means no strategy matched
if [ -z "$STRATEGY_ID" ] || [ "$STRATEGY_ID" = "null" ]; then
  echo "No devnet USDC strategy is open for deposits, or the request failed." >&2
  echo "Check SDP_API_KEY and SDP_API_URL." >&2
  exit 1
fi

# Build an unsigned deposit of 10 USDC from the wallet.
curl -sS "$SDP_API_URL/v1/earn/external-wallet/deposit-transactions" \
  -H "Authorization: Bearer $SDP_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<EOF | tee build.json | jq .
{ "strategyId": "$STRATEGY_ID", "ownerAddress": "$WALLET", "amount": "10" }
EOF
# A refused build printed the API's error above. Stop before signing.
jq -e '.error | not' build.json >/dev/null

# Sign the exact bytes SDP built.
SIGNED="$(node sign.mjs "$(jq -r .data.transaction.transaction build.json)")"

# Submit it. Each new deposit takes a new idempotency key.
curl -sS "$SDP_API_URL/v1/earn/external-wallet/deposits" \
  -H "Authorization: Bearer $SDP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(node -e 'console.log(crypto.randomUUID())')" \
  -d @- <<EOF | tee deposit.json | jq .
{
  "transactionId": "$(jq -r .data.transaction.transactionId build.json)",
  "signedTransaction": "$SIGNED"
}
EOF
jq -e '.error | not' deposit.json >/dev/null

# Poll until the deposit is final. The quickstart reruns this read by hand.
STATUS=""
until [ "$STATUS" = '"finalized"' ] || [ "$STATUS" = '"failed"' ]; do
  sleep 2
  STATUS="$(curl -sS "$SDP_API_URL/v1/earn/external-wallet/movements/$(jq -r .data.deposit.movementId deposit.json)" \
    -H "Authorization: Bearer $SDP_API_KEY" | jq .data.movement.status)"
  echo "$STATUS"
  if [ "$STATUS" = "null" ]; then
    echo "The movement read failed." >&2
    exit 1
  fi
done

# Read the wallet's positions.
curl -sS "$SDP_API_URL/v1/earn/external-wallet/positions?ownerAddress=$WALLET" \
  -H "Authorization: Bearer $SDP_API_KEY" | jq .data.positions
