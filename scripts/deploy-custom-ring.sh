#!/usr/bin/env bash
set -euo pipefail

# Deploys a Helius custom ring program to devnet and hands its upgrade
# authority to an SDP custody wallet, so the dashboard's "Record and bring up"
# step can complete bring-up through custody.
#
# What it does:
#   1. Creates a custody wallet in your SDP project (or reuses one you name).
#   2. Downloads the ring program of the pinned custom-rings release and
#      verifies its sha256 — the same check the zolana-ring CLI's lockfile does.
#   3. Deploys it under a throwaway deployer keypair (airdropped devnet SOL).
#   4. Transfers the program's upgrade authority to the custody wallet.
#   5. Funds the custody wallet — it fee-pays every bring-up transaction.
#
# What it deliberately does NOT do: `zolana-ring init`. Bring-up is SDP's
# init; a ring initialized outside custody can never be adopted by SDP.
#
# Usage:
#   SDP_API_KEY=sk_... scripts/deploy-custom-ring.sh <ring-label>
#
# Environment:
#   SDP_API_KEY             project API key with custody:admin, not
#                           wallet-scoped (dashboard -> API keys). Required
#                           unless CUSTODY_WALLET_ADDRESS is set.
#   SDP_API_URL             default http://localhost:8787
#   CUSTODY_WALLET_ADDRESS  reuse an existing custody wallet instead of
#                           creating one (skips the API call entirely).
#   WORK_DIR                default ~/.sdp-ring-deploy/<ring-label>
#
# Prerequisites: solana CLI 4.x, curl, jq, shasum.

RELEASE_TAG="v0.1.0-alpha.2"
RING_SO_URL="https://github.com/helius-labs/zolana/releases/download/${RELEASE_TAG}/custom-ring-program-${RELEASE_TAG}.so"
RING_SO_SHA256="041b94f53ff0ee291473b3cf407b7c8b535d87f2beb7a18c48e2034aa2235d81"
DEPLOY_BALANCE_SOL="1.4"   # ~1.23 SOL programdata rent + fees, with headroom
BRINGUP_FUND_SOL="0.05"    # rents config, ring-auth, reader record, lookup table

RING_LABEL="${1:-}"
if [ -z "$RING_LABEL" ]; then
  echo "usage: SDP_API_KEY=sk_... $0 <ring-label>" >&2
  exit 1
fi

SDP_API_URL="${SDP_API_URL:-http://localhost:8787}"
WORK_DIR="${WORK_DIR:-$HOME/.sdp-ring-deploy/$RING_LABEL}"
URL=(--url devnet)

for tool in solana solana-keygen curl jq shasum; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
mkdir -p "$WORK_DIR"

step() { printf '\n== %s\n' "$*"; }
balance_of() { solana balance "$1" "${URL[@]}" | awk '{print $1}'; }
# awk exits 0 on "under", 1 on "at or above" — usable directly in `if`.
below() { awk -v a="$1" -v b="$2" 'BEGIN { exit (a < b) ? 0 : 1 }'; }

# ── 1. The custody wallet that will own the ring ────────────────────────────
step "custody wallet"
CUSTODY_CACHE="$WORK_DIR/custody-wallet"
if [ -n "${CUSTODY_WALLET_ADDRESS:-}" ]; then
  CUSTODY_ADDRESS="$CUSTODY_WALLET_ADDRESS"
  echo "reusing custody wallet $CUSTODY_ADDRESS"
elif [ -s "$CUSTODY_CACHE" ]; then
  CUSTODY_ADDRESS="$(cat "$CUSTODY_CACHE")"
  echo "reusing custody wallet from previous run: $CUSTODY_ADDRESS"
else
  [ -n "${SDP_API_KEY:-}" ] || { echo "SDP_API_KEY is required (or set CUSTODY_WALLET_ADDRESS)" >&2; exit 1; }
  response="$(curl -sS -w '\n%{http_code}' -X POST "$SDP_API_URL/v1/wallets" \
    -H "Authorization: Bearer $SDP_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"label\": \"ring-authority-$RING_LABEL\"}")"
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [ "$http_code" != "201" ]; then
    echo "custody wallet creation failed (HTTP $http_code): $body" >&2
    echo "the API key needs custody:admin and must not be wallet-scoped" >&2
    exit 1
  fi
  CUSTODY_ADDRESS="$(jq -er '.data.wallet.publicKey' <<<"$body")"
  echo "created custody wallet ring-authority-$RING_LABEL: $CUSTODY_ADDRESS"
fi
# Persist for re-runs: the ring must keep one authority across resumes.
printf '%s\n' "$CUSTODY_ADDRESS" > "$CUSTODY_CACHE"

# ── 2. The ring program binary, hash-pinned to the release ──────────────────
step "ring program binary ($RELEASE_TAG)"
RING_SO="$WORK_DIR/custom-ring-program.so"
if [ ! -f "$RING_SO" ] || ! shasum -a 256 "$RING_SO" | grep -q "^$RING_SO_SHA256 "; then
  curl -sSL -o "$RING_SO" "$RING_SO_URL"
fi
shasum -a 256 "$RING_SO" | grep -q "^$RING_SO_SHA256 " \
  || { echo "downloaded binary does not match pinned sha256" >&2; exit 1; }
echo "sha256 verified: $RING_SO_SHA256"

# ── 3. Keypairs ──────────────────────────────────────────────────────────────
step "keypairs"
PROGRAM_KEYPAIR="$WORK_DIR/program-keypair.json"
DEPLOYER_KEYPAIR="$WORK_DIR/deployer.json"
[ -f "$PROGRAM_KEYPAIR" ] || solana-keygen new --no-bip39-passphrase -s -o "$PROGRAM_KEYPAIR" >/dev/null
[ -f "$DEPLOYER_KEYPAIR" ] || solana-keygen new --no-bip39-passphrase -s -o "$DEPLOYER_KEYPAIR" >/dev/null
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
DEPLOYER="$(solana-keygen pubkey "$DEPLOYER_KEYPAIR")"
echo "program id: $PROGRAM_ID"
echo "deployer:   $DEPLOYER"

# ── 4. Fund the deployer ─────────────────────────────────────────────────────
step "deployer balance"
if below "$(balance_of "$DEPLOYER")" "$DEPLOY_BALANCE_SOL"; then
  solana airdrop 2 "$DEPLOYER" "${URL[@]}" >/dev/null || true
fi
if below "$(balance_of "$DEPLOYER")" "$DEPLOY_BALANCE_SOL"; then
  echo "airdrop rate-limited; fund $DEPLOYER with ~$DEPLOY_BALANCE_SOL devnet SOL" >&2
  echo "(https://faucet.solana.com) and re-run — the script resumes where it left off" >&2
  exit 1
fi
echo "balance: $(balance_of "$DEPLOYER") SOL"

# ── 5. Deploy, unless the program already exists ─────────────────────────────
step "deploy"
show() { solana program show "$PROGRAM_ID" "${URL[@]}" -k "$DEPLOYER_KEYPAIR" 2>/dev/null; }
if show >/dev/null; then
  echo "program already deployed, skipping"
else
  solana program deploy "$RING_SO" \
    --program-id "$PROGRAM_KEYPAIR" -k "$DEPLOYER_KEYPAIR" "${URL[@]}"
fi

# ── 6. Hand the upgrade authority to custody ────────────────────────────────
step "upgrade authority"
AUTHORITY="$(show | awk '/^Authority/ {print $2}')"
if [ "$AUTHORITY" = "$CUSTODY_ADDRESS" ]; then
  echo "already held by custody wallet, skipping"
elif [ "$AUTHORITY" = "$DEPLOYER" ]; then
  # The custody wallet cannot co-sign a CLI transaction, hence the skip flag.
  # The address was read from the wallet SDP created, not typed by hand.
  solana program set-upgrade-authority "$PROGRAM_ID" \
    --new-upgrade-authority "$CUSTODY_ADDRESS" \
    --skip-new-upgrade-authority-signer-check \
    -k "$DEPLOYER_KEYPAIR" "${URL[@]}" >/dev/null
else
  echo "program authority is $AUTHORITY — neither this deployer nor the custody wallet." >&2
  echo "This program id belongs to someone else; remove $WORK_DIR and re-run." >&2
  exit 1
fi
AUTHORITY="$(show | awk '/^Authority/ {print $2}')"
[ "$AUTHORITY" = "$CUSTODY_ADDRESS" ] || { echo "authority verification failed: $AUTHORITY" >&2; exit 1; }
echo "verified on-chain: authority = $CUSTODY_ADDRESS"

# ── 7. Fund the custody wallet for bring-up ─────────────────────────────────
step "custody wallet balance"
if below "$(balance_of "$CUSTODY_ADDRESS")" "$BRINGUP_FUND_SOL"; then
  solana transfer "$CUSTODY_ADDRESS" "$BRINGUP_FUND_SOL" \
    --allow-unfunded-recipient -k "$DEPLOYER_KEYPAIR" "${URL[@]}" >/dev/null
fi
echo "balance: $(balance_of "$CUSTODY_ADDRESS") SOL"

# ── Done ─────────────────────────────────────────────────────────────────────
printf '\n✓ ring program ready\n\n'
echo "  program id:      $PROGRAM_ID"
echo "  custody wallet:  $CUSTODY_ADDRESS (ring-authority-$RING_LABEL)"
echo ""
echo "Next: dashboard -> Helius Rings -> Custom rings -> enter a ring name"
echo "with program id $PROGRAM_ID and submit. SDP's bring-up is the init:"
echo "never run 'zolana-ring init' against this program."
echo ""
echo "Note: a custody wallet used for a Helius Rings private wallet pays its own"
echo "identity registration and shield deposits. The deployer keeps its leftover"
echo "devnet SOL ($(balance_of "$DEPLOYER") SOL) — fund such a wallet with:"
echo "  solana transfer <address> 0.05 --allow-unfunded-recipient \\"
echo "    -k $DEPLOYER_KEYPAIR --url devnet"
