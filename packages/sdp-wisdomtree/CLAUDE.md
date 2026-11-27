# @sdp/wisdomtree — agent notes

Kit-native instruction building for WisdomTree Connect's tokenized funds on
Solana, live position reads and order-settlement observations. It builds
unsigned plans and reads chain/provider state; it never signs, submits or
touches a database. Signing and submission belong to the API. The Connect REST
client (OAuth, products, on-receipt wallets, admission and order lookup) lives
in `@sdp/earn/providers/wisdomtree/connect`; this package adds instruction
building and source-correlated settlement candidates.

Read `packages/sdp-earn/CLAUDE.md` for the catalogue side and ADR 0002 for the
pluggability invariants. `@sdp/kamino` is the structural precedent; the notes
below cover only what is DIFFERENT here.

## There is no vault — a "deposit" is a primary-market order's on-chain leg

A WisdomTree fund is a Token-2022 MINT (the docs' registry mislabels the mint
accounts "Program" — decode them, don't trust the table). Money moves like
this:

- **Subscription (money in):** TransferChecked of USDC from the owner to
  WisdomTree's _on-receipt Purchase wallet_, resolved from the Connect API at
  build time. Receiving USDC from a KYC-registered wallet is what opens the
  order; fund tokens settle back to the owner AFTER NAV strike, outside the
  transaction. The plan therefore also creates the owner's fund-token ATA when
  measured absent (that is the `createsShareAccount` the ledger records).
- **Redemption (money out):** TransferChecked of fund tokens to the
  _on-receipt Sale wallet_; USDC settles back later. No account is ever closed
  — `rentRefundTo` is accepted and unused.

Consequences that differ from Kamino:

- **`minSharesOut` is refused, never ignored.** Settlement happens at a NAV
  struck after the transfer lands; no instruction can encode a share floor.
- **A confirmed movement is not a settled order.** When Solana finalizes the
  payment or share leg, the sweep keeps the movement `confirmed` and records
  chain finality as its own fact (`chain_finalized_at`), which takes the row
  off the chain queue; the operation reads `settling`. Fund tokens (or
  redemption USDC) arrive later through WisdomTree's transfer agent, so that
  chain fact never closes the position, schedules payout repair or recognizes
  earnings. `readProviderSettlement` reads Connect's order by the recorded
  source hash. Only a matching `Settled` order supplies a destination candidate;
  the shared reconciler verifies finalized delivery before moving the row to
  `finalized`. Position reads still surface assets from live chain state.

The on-receipt address is resolved live before review and becomes immutable
signed terms. Before launch, confirm with the issuer that it remains valid for
the complete recent-blockhash signing window; the API exposes no reservation,
version or old-address grace guarantee. Never change a recipient after review.
The shared worker rechecks deposit eligibility before broadcast, including after
custody approval, without gating exits or settlement reads.

## Shared order settlement

`readProviderSettlement` uses the shared `EarnProviderSettlementInput` and
`EarnProviderSettlementCandidate` contracts. It runs through
`EarnVaultOperationRunner` without resolving an RPC endpoint. A warm observation
makes one `GET /api/orders/hash/{sourceSignature}`; a cold observation adds the
existing OAuth grant, and a revoked bearer can refresh once. No order creation,
missing-hash POST, eligibility, wallet or organization read runs here. Recovery
does not depend on current deposit entitlement.

Match the source hash in its economic role, wallet, fund code and mint,
Purchase/Sale direction, Solana network and USDC currency name. Connect may
encode the raw currency as `"2"`; its name supplies the currency identity.
Purchases match the conversion or deposit source and return the issuer share
hash. Sales match the incoming deposit source and return the conversion payout
hash, never a token-burn hash. A source hash cannot also prove delivery.

Only exact `Settled` supplies a candidate. Missing/inaccessible orders, unknown
statuses and missing hashes stay pending. `Failed`, `Order Failed`,
`Order Refunded` and `Cancelled` require recovery without claiming a refund or
payout. The write-scoped `fetch-hash` endpoint remains an operator action if
automatic hash population stalls.

The candidate names the owner's fund or USDC ATA and the Token-2022 or SPL
Token program. Its reported output (`token_amount` for Purchase, `net_value`
for Sale) is a conservative cross-check, not ledger evidence: missing values
or a mismatch with the finalized token delta cannot complete the operation.
This refuses an ambiguous aggregate credit rather than assigning it to one
order. The provider's precise amount conventions and batched-delivery behavior
still need live validation. The shared delivery-signature uniqueness guard
continues to prevent one receipt from settling multiple movements.

## The compliance model is the integration's spine

Every fund mint carries a transfer hook (shared program
`F4wFSShcdmaHWGRRXhCHinNTt8spgdh26Wi8hbN2Rzbh` on mainnet, measured) that
enforces WisdomTree's KYC on EVERY transfer: wallets must be verified by the
issuer (registrar-issued credential) to move or receive fund tokens. Three
layers in SDP, none redundant:

1. **API-side pre-check** (`EarnDepositEligibilityProvider`, money-in only):
   in one authenticated Connect context, the wallet registry must report the
   sender Approved AND the products shelf must contain the requested registry
   fund with `can_trade === true`. Preparation checks this once; the worker
   checks the recorded owner and fund again before broadcast after any custody
   approval delay. A negative result stops new sends while exposed signed bytes
   remain under observation; an upstream outage retries without broadcasting.
   Neither approval polling nor exits/settlement gain this money-in gate.
   Refusal stays generic so preparation and operation errors cannot reveal
   wallet registration, KYC state or product entitlements. This is an admission
   check, not an on-chain restriction on the USDC source transfer.
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

Hosted Earn uses **Moderator mode**. The onboarding API maps a project-scoped
SDP counterparty to the Connect child GUID returned by its business application;
wallet registration binds a Solana owner to that customer. Admission resolves
that stored mapping and verifies the moderator's LIVE `client_organizations`
before reading the child's wallets and products (`organization_guid` query).
A missing/revoked mapping, pending wallet or missing product receives the same
non-enumerating refusal. A retail person's GUID is stored separately and never
turns the moderator's GUID into a child. Retail-only KYC does not enable this
business-wallet rail.

The standalone package's direct-org tooling remains available without a
customer reference. Hosted deposits always require the durable mapping.
Setup, endpoints, sensitive-data handling and operator recovery:
`docs/architecture/wisdomtree-onboarding.md`.

Builds read every account they can name up front in one `getAccounts` request
(deposit: mint, owner fund ATA, on-receipt USDC ATA; redemption: mint,
on-receipt fund ATA, ExtraAccountMetaList, owner fund ATA). Hook resolution
reads through that snapshot and fetches any other seed account once.

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
- The documented on-receipt order hash roles, status and amount fields are
  implemented but still need verification against a live Solana tenant.
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

- **Surfacing stays `false`** (`EARN_PROVIDER_DESCRIPTORS.wisdomtree.surfaced`). The
  playbook's rule is flip LAST, in its own PR, after an end-to-end deposit —
  which needs real Connect credentials AND production vault-direct deposits
  (PRO-1703): WisdomTree is mainnet-only and their sandbox is Ethereum
  Sepolia, so no official Solana sandbox E2E exists. The Surfpool round trip
  proves the on-chain integration only; it does not clear this gate.
- **Live order settlement validation**: verify both source/destination hash
  roles, exact reported output conventions, and finalized issuer delivery with
  an authorized tenant. Offline tests exercise the real reader and shared
  reconciler; they do not establish a live transfer-agent settlement.
- **Fund Data (Dataspan) rates**: catalogue rows carry no `currentApy` until
  the second credential exists and its routes are measured. Missing renders
  "—", never a fabricated rate.
- **Business prerequisites**: a WisdomTree Connect agreement using the
  Moderator model, a verified and assigned child customer, per-wallet
  registration, fund entitlement, and packed
  credentials in `WISDOMTREE_API_KEY` / `WISDOMTREE_SANDBOX_API_KEY`
  (format on `EarnRuntimeEnvironment`). Onboarding does not clear the separate
  production deposit and provider-surfacing launch gates.
