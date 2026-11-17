#!/usr/bin/env bash
# The Treasury quickstart's cURL path: the same requests as deposit.mts, in order.
# Treasury, not Embedded Yield: the funds are your organization's own, in a
# custody wallet SDP signs for, so nothing is signed here.
# Needs curl, jq and Node.js. Run it from this folder.
set -euo pipefail

: "${SDP_API_KEY:?Set SDP_API_KEY to an API key with Earn Execute and Wallets Read}"
: "${WALLET:?Set WALLET to the address of your custody wallet}"
# The hosted sandbox by default. Set SDP_API_URL to use another API.
SDP_API_URL="${SDP_API_URL:-https://api-beta.solana.com}"

# Find your custody wallet's ID by its address.
export WALLET_ID="$(curl -sS "$SDP_API_URL/v1/wallets" \
  -H "Authorization: Bearer $SDP_API_KEY" |
  jq -r --arg address "$WALLET" '.data.wallets[] | select(.publicKey == $address) | .id')"
echo "$WALLET_ID" # empty means the key cannot see that wallet
if [ -z "$WALLET_ID" ]; then
  echo "This API key cannot see that wallet, or the request failed." >&2
  echo "Check SDP_API_KEY, SDP_API_URL and WALLET, and that the key has Wallets Read." >&2
  exit 1
fi

# Fetch the strategies, and take one that is open for deposits, takes devnet USDC,
# and needs no slippage floor.
export STRATEGY_ID="$(curl -sS "$SDP_API_URL/v1/earn/strategies?pageSize=100" \
  -H "Authorization: Bearer $SDP_API_KEY" | jq -r '
    [.data.strategies[] | select(.fundable and .status == "active" and .depositSlippage == null
      and .depositMints[0] == "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")][0].id')"
echo "$STRATEGY_ID" # "null" means no strategy matched
if [ -z "$STRATEGY_ID" ] || [ "$STRATEGY_ID" = "null" ]; then
  echo "No devnet USDC strategy is open for deposits, or the request failed." >&2
  exit 1
fi

# Deposit 10 USDC. Each new deposit takes a new idempotency key.
curl -sS "$SDP_API_URL/v1/earn/vault-deposits" \
  -H "Authorization: Bearer $SDP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(node -e 'console.log(crypto.randomUUID())')" \
  -d @- <<EOF | tee deposit.json | jq .
{ "strategyId": "$STRATEGY_ID", "custodyWalletId": "$WALLET_ID", "amount": "10" }
EOF
# A refused deposit printed the API's error above. Stop before polling.
jq -e '.error | not' deposit.json >/dev/null

# Poll until the network confirms the deposit. The quickstart reruns this read by hand.
STATUS=""
until [ "$STATUS" = '"confirmed"' ] || [ "$STATUS" = '"failed"' ]; do
  sleep 2
  STATUS="$(curl -sS "$SDP_API_URL/v1/earn/vault-deposits/$(jq -r .data.movementId deposit.json)" \
    -H "Authorization: Bearer $SDP_API_KEY" | jq .data.deposit.status)"
  echo "$STATUS"
  if [ "$STATUS" = "null" ]; then
    echo "The deposit read failed." >&2
    exit 1
  fi
done

# Read your project's custody positions.
curl -sS "$SDP_API_URL/v1/earn/vault-positions" \
  -H "Authorization: Bearer $SDP_API_KEY" | jq .data.positions
