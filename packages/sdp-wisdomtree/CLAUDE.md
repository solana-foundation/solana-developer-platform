# @sdp/wisdomtree — agent notes

Kit-native instruction building for WisdomTree Connect's tokenized funds on
Solana, plus live position reads. It builds unsigned plans and reads chain
state; it never signs, never submits, never touches a database. Signing and
submission belong to the API. The Connect REST client (OAuth, products,
on-receipt wallets, deposit admission) lives in
`@sdp/earn/providers/wisdomtree/connect` — this package consumes it and adds
the chain half.

Read `packages/sdp-earn/CLAUDE.md` for the catalogue side and ADR 0002 for the
pluggability invariants. `@sdp/kamino` is the structural precedent; the notes
below cover only what is DIFFERENT here.

## There is no vault — a "deposit" is a primary-market order's on-chain leg

A WisdomTree fund is a Token-2022 MINT (the docs' registry mislabels the mint
accounts "Program" — decode them, don't trust the table). Money moves like
this:

- **Subscription (money in):** TransferChecked of USDC from the owner to
  WisdomTree's *on-receipt Purchase wallet*, resolved from the Connect API at
  build time. Receiving USDC from a KYC-registered wallet is what opens the
  order; fund tokens settle back to the owner AFTER NAV strike, outside the
  transaction. The plan therefore also creates the owner's fund-token ATA when
  measured absent (that is the `createsShareAccount` the ledger records).
- **Redemption (money out):** TransferChecked of fund tokens to the
  *on-receipt Sale wallet*; USDC settles back later. No account is ever closed
  — `rentRefundTo` is accepted and unused.

Consequences that differ from Kamino:

- **`minSharesOut` is refused, never ignored.** Settlement happens at a NAV
  struck after the transfer lands; no instruction can encode a share floor.
- **A confirmed movement is not a settled order.** Even after Solana reports
  the payment/share leg finalized, that finality is all the ledger records:
  the sweep stamps the durable chain fact (`finalized`/`settled_at`) and then
  stops scheduling the row, but fund tokens (or redemption USDC) arrive later
  through WisdomTree's transfer agent. The stamp never leaves the ledger: the
  public wire (`movementStatusOnWire`) translates a provider-order row at
  `finalized` down to `confirmed` with no `settledAt`, because the contract
  defines `finalized` as terminal settlement, and the settled surface never
  closes a provider-order row on a chain fact. Connect's order completion —
  the authenticated, correlated provider signal — is what a future reconciler
  must bring before the settled view can close these rows. Position reads
  still surface assets from live chain state. Order-status polling against
  `GET /api/orders/*` is deliberately NOT wired yet — see "Not done" below.

## The compliance model is the integration's spine

Every fund mint carries a transfer hook (shared program
`F4wFSShcdmaHWGRRXhCHinNTt8spgdh26Wi8hbN2Rzbh` on mainnet, measured) that
enforces WisdomTree's KYC on EVERY transfer: wallets must be verified by the
issuer (registrar-issued credential) to move or receive fund tokens. Three
layers in SDP, none redundant:

1. **API-side pre-check** (`EarnDepositEligibilityProvider`, money-in only):
   in one authenticated Connect context, the wallet registry must report the
   sender Approved AND the products shelf must contain the requested registry
   fund with `can_trade === true` before USDC leaves. A valid negative result
   always gets the same generic refusal: the optional-auth build route must not
   reveal whether a wallet is registered, its KYC state, or the organization's
   product entitlements. Malformed/upstream responses fail closed.
2. **Hook account resolution** (`transfer-hook.ts`): the standard SPL
   tlv-account-resolution algorithm, evaluated against the hook's LIVE
   ExtraAccountMetaList. WTGXX's real list (measured 2026-08-28): a
   literal-seeded compliance-config PDA, two literal accounts, and two
   account-data-seeded PDAs on an external program keyed by the source/dest
   owners — the per-wallet compliance state. Resolution failures surface as
   `WITHDRAW_REFUSED` (the API's caller-fixable 400): SDP only ever builds
   fund-token transfers for redemptions, and resolution failing IS the KYC
   gate answering no.
3. **The hook itself**, on-chain, at execution — the backstop nothing in SDP
   can bypass. The surfpool smoke test demonstrates it rejecting an unverified
   wallet's redemption.

A hook entry demanding an extra SIGNER is refused outright: the only signer a
transfer carries is the owner.

### Supported Connect organization model

Admission currently supports only Connect's **direct/omnibus credential**
model. `GET /api/organizations/me` identifies the organization whose wallet
registry and credential-scoped product shelf SDP checks. A moderator B2B2C
credential requires an explicit, durable mapping from an SDP organization to
the correct Connect child-organization GUID. No such mapping exists today, so
the integration does not guess a child organization and does not claim
moderator-mode support.

## Build-time mint verification

`verifyFundMint` compares the LIVE mint (owner program, initialized/paused
state, decimals, hook program) against the measured registry in
`@sdp/types/wisdomtree-programs` before any plan is built — builder truth for
a vaultless provider. The registry is measurements, not docs: every fund row
was decoded from the mainnet mint account (`fixtures.test-helper.ts` carries
the verbatim WTGXX image the tests parse).

## UNVERIFIED wire fields — first things to re-measure when credentials arrive

SDP holds no Connect credentials yet, so unlike Ground the REST shapes come
from WisdomTree's published OpenAPI spec, not from a live tenant. Each is one
constant or reader in `@sdp/earn/providers/wisdomtree/connect.ts`:

- `WISDOMTREE_SOLANA_BLOCKCHAIN_KEY = "Solana"` (their examples only show
  Ethereum values; confirm via `GET /api/orders/order-mapping`).
- The organization guid field name (three spellings accepted).
- Wallet `status` vocabulary (only `"approved"` passes; fail-closed).
- The on-receipt order lifecycle/correlation fields needed to reconcile a
  Solana transfer with the later provider settlement.
- **The OAuth grant itself**: Connect documents only the Resource Owner
  Password Credentials grant (`grant_type=password`, `POST /o/token/`) — the
  plaintext-username/password flow ROPC deprecations target. Whether
  WisdomTree has shipped a replacement (client-credentials or an
  authorization flow) is UNMEASURED without a tenant; re-check their docs
  when credentials arrive. Until then SDP accepts ROPC deliberately: the
  credential tuple never leaves SDP's secret storage except to TLS-protected
  `POST /o/token/` calls (HTTPS production/sandbox hosts, pinned in
  `connect.ts`), no password is persisted anywhere else, and the bearer cache
  keys tokens by a SHA-256 digest so plaintext credentials cannot leak
  through the in-memory map.

## Smoke test — the mainnet-fork proof

`src/smoke.surfpool.test.ts` is opt-in and never part of the ordinary offline
suite. It deliberately refuses anonymous/impersonated-holder testing. From the
repository root, provide a mainnet RPC, packed **production** Connect
credentials, and a user-controlled mainnet signer that really holds SOL, USDC,
WTGXX, and a live WisdomTree credential. Preload the three required variables
from a secure environment or secret manager; do not inline their values in an
interactive shell command where history can retain them. Then run the
Docker-only wrapper (the host never needs Node or pnpm):

```bash
scripts/kora-surfpool/e2e-wisdomtree.sh
```

The wrapper passes all three values into a pinned linux/amd64 container by
inherited environment-variable **names**, never values in process arguments;
all Node/pnpm work stays inside that image. The test checks the signer assets on
the remote mainnet first, resolves the real Purchase and Sale on-receipt wallets
through `getWisdomTreeOnReceiptWallet`, cryptographically signs every Surfpool
simulation with signature verification enabled, and asserts one-atom exact
source/destination deltas for both real on-receipt transfers.

Its negative hook control uses the same real signer and a fresh recipient. The
only `surfnet_*` state write clones the signer's real registrar credential
account shape into that recipient's exact derived KYC ATA; all cheatcodes are
then permanently locked before the positive hook and on-receipt proofs. There
is no SOL, USDC, or WTGXX funding shortcut, no noop/impersonated signer, no
fake settlement, and no broadcast. Consequently the proof exercises Connect
wallet resolution and the real on-chain legs, but does **not** claim that
WisdomTree struck NAV, delivered subscription shares, paid redemption proceeds,
or completed an actual transfer-agent order.

## Not done, deliberately — the go-live checklist

- **Surfacing stays `false`** (`EARN_PROVIDER_SURFACING.wisdomtree`). The
  playbook's rule is flip LAST, in its own PR, after an end-to-end deposit —
  which needs real Connect credentials AND production vault-direct deposits
  (PRO-1703): WisdomTree is mainnet-only and their sandbox is Ethereum
  Sepolia, so no official Solana sandbox E2E exists. The Surfpool round trip
  proves the on-chain integration only; it does not clear this gate.
- **Order-settlement tracking** (poll `GET /api/orders/*`, correlate with
  movements, surface "order in flight" between transfer finality and token
  settlement) — same expand-only schema question as Veda's queue
  (`veda/plan.md`); solve them together.
- **Fund Data (Dataspan) rates**: catalogue rows carry no `currentApy` until
  the second credential exists and its routes are measured. Missing renders
  "—", never a fabricated rate.
- **Business prerequisites**: a WisdomTree Connect agreement using the
  currently supported direct/omnibus credential model, per-wallet KYC
  registration, fund entitlement, and packed
  credentials in `WISDOMTREE_API_KEY` / `WISDOMTREE_SANDBOX_API_KEY`
  (format on `EarnRuntimeEnvironment`). Moderator B2B2C operation remains
  blocked on a durable SDP-org-to-Connect-child mapping.
