# @sdp/wisdomtree — agent notes

Kit-native instruction building for WisdomTree Connect's tokenized funds on
Solana, plus live position reads. It builds unsigned plans and reads chain
state; it never signs, never submits, never touches a database. Signing and
submission belong to the API. The Connect REST client (OAuth, products,
on-receipt wallets, wallet eligibility) lives in
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
- **A confirmed movement is not a settled order.** The ledger's `finalized`
  means the on-chain leg landed; the fund tokens (or redemption USDC) arrive
  via WisdomTree's transfer agent afterwards, and positions surface them
  because position reads are live chain reads. Order-status polling against
  `GET /api/orders/*` is deliberately NOT wired yet — see "Not done" below.

## The compliance model is the integration's spine

Every fund mint carries a transfer hook (shared program
`F4wFSShcdmaHWGRRXhCHinNTt8spgdh26Wi8hbN2Rzbh` on mainnet, measured) that
enforces WisdomTree's KYC on EVERY transfer: wallets must be verified by the
issuer (registrar-issued credential) to move or receive fund tokens. Three
layers in SDP, none redundant:

1. **API-side pre-check** (`EarnDepositEligibilityProvider`, money-in only):
   the Connect wallet registry answers registered+approved before USDC leaves,
   so an unverified wallet gets a refusal with the provider's reason instead
   of "USDC left and nothing came back". Fail-closed on unknown statuses.
2. **Hook account resolution** (`transfer-hook.ts`): the standard SPL
   tlv-account-resolution algorithm, evaluated against the hook's LIVE
   ExtraAccountMetaList. WTGXX's real list (measured 2026-08-28): a
   literal-seeded compliance-config PDA, two literal accounts, and two
   account-data-seeded PDAs on an external program keyed by the source/dest
   owners — the per-wallet compliance state. Resolution failures surface as
   `HOOK_UNRESOLVED`.
3. **The hook itself**, on-chain, at execution — the backstop nothing in SDP
   can bypass. The surfpool smoke test demonstrates it rejecting an unverified
   wallet's redemption.

A hook entry demanding an extra SIGNER is refused outright: the only signer a
transfer carries is the owner.

## Build-time mint verification

`verifyFundMint` compares the LIVE mint (owner program, decimals, hook
program) against the measured registry in `@sdp/types/wisdomtree-programs`
before any plan is built — builder truth for a vaultless provider. The
registry is measurements, not docs: every fund row was decoded from the
mainnet mint account (`fixtures.test-helper.ts` carries the verbatim WTGXX
image the tests parse).

## UNVERIFIED wire fields — first things to re-measure when credentials arrive

SDP holds no Connect credentials yet, so unlike Ground the REST shapes come
from WisdomTree's published OpenAPI spec, not from a live tenant. Each is one
constant or reader in `@sdp/earn/providers/wisdomtree/connect.ts`:

- `WISDOMTREE_SOLANA_BLOCKCHAIN_KEY = "Solana"` (their examples only show
  Ethereum values; confirm via `GET /api/orders/order-mapping`).
- The organization guid field name (three spellings accepted).
- Wallet `status` vocabulary (only `"approved"` passes; fail-closed).
- The `/api/orders/all` envelope (bare array and `{orders}` both accepted).

## Smoke test — the mainnet-fork proof

`src/smoke.surfpool.test.ts`, env-gated (`WISDOMTREE_SMOKE_RPC_URL` +
`WISDOMTREE_SMOKE_SIGNER`), never in CI. Run `surfpool start --no-tui`
(mainnet fork), fund the throwaway signer via `surfnet_setAccount` /
`surfnet_setTokenAccount` cheatcodes, and it proves against the REAL mint and
hook: the subscription leg simulates cleanly, and an unverified wallet's
redemption fails at the KYC stage (resolver refusal or on-chain hook
rejection — the test accepts exactly those two). Last run 2026-08-28: all
three passed; the redemption resolved fully and the hook program rejected it
in simulation.

## Not done, deliberately — the go-live checklist

- **Surfacing stays `false`** (`EARN_PROVIDER_SURFACING.wisdomtree`). The
  playbook's rule is flip LAST, in its own PR, after an end-to-end deposit —
  which needs real Connect credentials AND production vault-direct deposits
  (PRO-1703): WisdomTree is mainnet-only and their sandbox is Ethereum
  Sepolia, so no sandbox E2E can exist.
- **Order-settlement tracking** (poll `GET /api/orders/*`, correlate with
  movements, surface "order in flight" between transfer finality and token
  settlement) — same expand-only schema question as Veda's queue
  (`veda/plan.md`); solve them together.
- **Fund Data (Dataspan) rates**: catalogue rows carry no `currentApy` until
  the second credential exists and its routes are measured. Missing renders
  "—", never a fabricated rate.
- **Business prerequisites**: a WisdomTree Connect agreement (moderator-org
  model for B2B2C partners), per-wallet KYC registration, and packed
  credentials in `WISDOMTREE_API_KEY` / `WISDOMTREE_SANDBOX_API_KEY`
  (format on `EarnRuntimeEnvironment`).
