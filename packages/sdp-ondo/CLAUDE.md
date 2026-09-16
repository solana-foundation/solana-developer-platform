# @sdp/ondo — agent notes

Swap-plan **instruction building** for Ondo's USDY on Solana, plus the live
position read. It builds unsigned plans and reads chain state; it never signs,
never submits, never touches a database, and holds no credential. Signing and
submission belong to the API, which owns custody.

Read `packages/sdp-earn/CLAUDE.md` for the catalogue side and ADR 0002 for the
pluggability invariants. `packages/sdp-kamino` and `packages/sdp-veda` are the
precedents this package mirrors; the differences are the interesting part.

## There is no vault program — the "vault" is the open market

USDY on Solana is a plain SPL token (6 decimals, mainnet only) whose per-token
price accrues Treasury yield. So:

- **Deposit** = Jupiter-routed ExactIn swap USDC→USDY, signed by the owner.
- **Position** = the owner's USDY token balance. Share mint == the instrument.
- **Exit** = the reverse swap. Always open, no lock (`liquidityTerm: instant`).
- **Exchange rate** = the live market price, which is why BOTH builders require
  an explicit slippage floor and both quote capabilities exist to derive one.

**The primary mint/redeem facility is deliberately not used** (PRO-1803,
measured 2026-09-02): fresh primary mints carry a 40–50 day Reg S transfer
lockup and sub-$100k primary redemptions wait out that window — incompatible
with on-demand exits. Using the secondary market instead is what makes this
provider keyless. Ondo's credentialed GM API (`api.gm.ondo.finance`, staging
`api.gm-staging.ondo.finance` — staging also runs ON MAINNET with different
mints) remains available for a later live-metrics capability or a large-size
redemption backstop; both need Ondo onboarding (API key + KYC + allowlisting).

## The rate comes from Ondo's public assets API, keyless (PRO-1833)

Decided 2026-09-15 with Ondo. `@sdp/earn` (`providers/ondo/usdy-rate.ts`)
reads `GET https://ondo.finance/api/v1/assets` — the endpoint Ondo pointed SDP
at for the current USDY APY (`/assets/history` has the daily series) — and
writes the `usdy` entry's `apy` (a percent) as a six-place decimal fraction,
truncated, plus its Solana `tvlUsd`, in the HOURLY catalogue sync. Ondo sets
the rate monthly, so the five-minute metrics pass would buy nothing.

Two things that look like the source and are not:

- **The credentialed GM API** (`api.gm.ondo.finance`, `x-api-key`) is the Ondo
  STOCKS API: 452 tokenized equities/ETFs, no USDY, no yield field (verified
  with a key 2026-09-15). The `ONDO_API_KEY` in Doppler `dev_personal` is for
  that API and nothing here reads it. No `ONDO_API_KEY` env plumbing exists.
- **Ondo's `RWADynamicOracle` on Ethereum** publishes the same rate as a daily
  multiplier. Ondo offered to deploy a Solana equivalent once there are users;
  that would make the read on-chain, but nothing here depends on it.

Credential path: none. An unreachable or malformed read fails the Ondo pass
(rows keep their last figures, the outage is logged) rather than nulling the
rate.

## The Jupiter swap seam is injected

This package uses the generated Kit compute-budget builder for its local
compute limit; it carries no Jupiter execution client. Swap instructions come
through `OndoSwapPort`
(`src/types.ts`), implemented by the API over its reviewed Jupiter trust
boundary (`apps/sdp-api/src/services/earn/jupiter-swap.service.ts`: pinned
aggregator/ATA programs, no signer but the owner, encoded amounts matching the
request). **Never re-implement instruction admission here** — a second owner of
that boundary is how the two drift. The port is resolved per request (like the
proven-RPC resolver) because the Jupiter key is request-environment state.

What this package adds on top of an admitted leg is exactly one instruction it
builds itself: the `SetComputeUnitLimit` (`ONDO_SWAP_COMPUTE_UNIT_LIMIT`)
prepended to every plan, because a Jupiter route routinely exceeds the default
budget and this builder has no simulation seam to derive a tighter one.

## The floor is proven, not encoded

Jupiter encodes a quote plus a tolerance, never an arbitrary floor. The builder
quotes live, derives `bps = ⌊(quote − floor)/quote·10⁴⌋` (rounding the
tolerance down rounds the threshold up), then checks the BUILT leg's own
threshold covers the caller's floor — one retry at zero tolerance, then a typed
`DEPOSIT_REFUSED`/`WITHDRAW_REFUSED`. `accepted` reports the CALLER's floor:
the encoded threshold is at or above it, so the ledger claim stays conservative
and exact against the API's policy check (`requireAcceptedPlan` demands
equality with the approved request).

`minSharesOut`/`minAmountOut` are refused-if-absent (Veda's rule): a floor
nobody chose is the appearance of protection. Amounts are refused, never
rounded, at the pair's 6-decimal scale (`canonicalAmount`).

## Positions are read in base units, and the valuation may be absent

Balances sum the exact raw `amount` integer strings from
`getTokenAccountsByOwner` — never `uiAmount` (lossy above 2^53). The valuation
comes from the EXIT quote (what the market would actually pay), and may fail
independently of the balance read: a quote outage makes the VALUE unknown, not
the HOLDING. Rent: deposits fund the USDY ATA from the owner (Jupiter's setup
creates charge the taker), so a foreign `rentPayer` is refused; exits close
nothing, so `rentRefundTo` is accepted and unused.

## Sponsorship never applies, and the declaration is still honest

`sponsoredPrograms` answers `[]` on devnet (no deployment — Ondo has none, and
their staging is mainnet too) and the truthful `[ComputeBudget, ATA, Jupiter]`
set on mainnet. Nothing is ever sponsored in practice: Earn sponsorship is
devnet-gated and swap plans force wallet-pays anyway, so this is declaration
hygiene for the allowlist assertions, not a request to allowlist Jupiter in
Kora.

## Tests

`vitest run`, offline by default. `sdk.smoke.test.ts` is the env-gated
exception — run it against a surfpool surfnet forking MAINNET (the only place
USDY exists):

```bash
ONDO_SMOKE_RPC_URL=http://127.0.0.1:8899 ONDO_SMOKE_SIGNER=<64 hex chars> pnpm --filter @sdp/ondo test
```

Fund the signer with SOL and USDC via surfpool's cheatcodes first. It proves
the full round trip — quote → floor → build → simulate → land → position read →
full exit — through real Orca/Manifest liquidity with no mainnet money at risk
(measured round-trip cost ~0.31% on $100, 2026-09-02). The smoke test's swap
port speaks Jupiter's keyless lite API, so it does not exercise the API's
instruction admission; that boundary has its own suite.
