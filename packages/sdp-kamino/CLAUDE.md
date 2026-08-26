# @sdp/kamino — agent notes

Kit-native deposit AND withdraw **instruction building** for Kamino K-Vaults,
plus the live position read. It builds unsigned plans and reads chain state; it
never signs, never submits, never touches a database, and holds no credential —
Kamino's data surface is public. Signing and submission belong to the API, which
owns custody and the Kora fee-payment path.

Read `packages/sdp-earn/CLAUDE.md` for the catalogue side (what a K-Vault row IS)
and ADR 0002 for the pluggability invariants. Kamino's own docs are agent-readable
and authoritative — start at <https://kamino.com/docs/skill.md>; every page is
fetchable as raw markdown by appending `.md`. **Do not answer Kamino questions
from memory**: this integration has already cost one durable wrong premise (see
"mainnet only" in `@sdp/earn`).

## The trap this package exists to contain

`new KaminoVault(rpc, addr, state, programId)` applies `programId` to **account
reads only**. Its constructor then builds its own `KaminoVaultClient` *without
forwarding it*, and instruction building goes through that client — which
defaults to **mainnet**. On devnet the result is a vault that reads `devkRng…`
state and emits instructions addressed to `KvauGM…`, with no error at any layer.

**Kamino's own published recipe uses that constructor**, so this is the default
outcome for anyone following the docs. Measured 2026-08-15; it is not theoretical.

Three layers hold the line, and none is redundant:

1. `bindVault` (sdk.ts) is the ONLY place a vault is constructed, and it uses
   `KaminoVault.loadWithClientAndState(client, addr, state)` — the one factory
   that sets `vault.programId` **and** `vault.client` together.
2. `assertPlanTargetsCluster` re-checks the **output** against a per-cluster
   program allowlist. Layer 1 is a convention inside one function; only layer 2
   is a property of what we actually emit, and only it survives an SDK upgrade
   that reshuffles construction.
3. `sdk-construction.test.ts` greps this package's own source, because both of
   the above are invisible to the type checker.

## The kit-version firewall

klend-sdk is built against `@solana/kit` **^2.3.0**; this repo pins **6.8.0**, and
both copies live in the tree (pnpm nests the SDK's own). Verified by a live round
trip: instructions come back as plain objects with a numeric `AccountRole` and
`Uint8Array` data, so kit 6.8 compiles and signs them unchanged — the boundary is
real at the TYPE level and inert at RUNTIME.

`src/sdk.ts` is the only module that may import `@kamino-finance/klend-sdk` or
`decimal.js`. Everything crossing this package's surface is `@solana/kit` 6.8,
`@sdp/types`, or a **decimal string**. A `Decimal` escaping would also drag in the
instance-identity hazard: klend-sdk compares with `instanceof Decimal`, so two
physical copies degrade to NaN rather than to a type error — which is why the root
`package.json` pins `decimal.js` via `pnpm.overrides`.

## Constants that are MEASUREMENTS, not protocol facts

All in `@sdp/types/kamino-programs` (there, not here, because `@sdp/earn` needs the
devnet kvault id too and an edge between the two packages would be a workspace
cycle *and* would drag a 13MB SDK into the hourly catalogue cron).

- **`KAMINO_SLOT_DURATION_MS`** — required by `KaminoVaultClient` and with no safe
  default. It scales every accrual the SDK computes (exchange rate, APY, farm
  rewards), so a wrong value yields plausible WRONG NUMBERS with no error — the
  same silent class as the program trap, and one no instruction assertion catches.
  Measured 2026-08-15 over a 4,000-slot span: **mainnet ≈ 416 ms, devnet ≈ 265 ms**.
  Both differ from klend-sdk's own default of 400. Re-measure rather than adjust
  by feel.
- **`KAMINO_KVAULT_PROGRAM_IDS`** — the one address that DIFFERS per cluster.
  Mainnet's id also exists on devnet with zero accounts, so aiming at the wrong one
  yields a confident empty result rather than an error.
- **klend and farms are the SAME id on both clusters** — verified deployed and
  executable on each, explicitly, because a farms id that differed per cluster
  would fail exactly the way kvault does. Both are still expressed as per-cluster
  records so a future divergence is a data change here, not a hunt through callers.

## `payer` is NOT the transaction fee payer

klend-sdk's `payer?: TransactionSigner` is the **rent payer for created ATAs**
(the 6th positional arg to `depositIxs`, 7th to `withdrawIxs`), embedded in the
instruction accounts as writable+signer. SDP's Kora path is different machinery:
it sets the fee payer at compile time and signs post-compile via
`signAsFeePayer(bytes)`. The field is `rentPayer` here to keep the two apart, and
it defaults to the owner.

**The sponsor may be named here on devnet, and PRO-1736 does exactly that.** This
section used to forbid it; the reversal is deliberate, so the reasoning is
recorded rather than dropped. The objection was that a sponsor would be billed for
rent its `FeePayerPolicy` might refuse and that `sponsorship-budget.service.ts`
did not account for. Both were verified against the deployed configuration:

- Kora gates fee-payer-funded ATA creation on one flag,
  `fee_payer_policy.system.allow_create_account` (its
  `validate_ata_create_instructions` returns early when true). devnet sets it
  true; mainnet keeps it false and sdp-infra's `validate-policy.py` fails CI on
  any `true` there.
- The budget prices it, because that same flag is one of the authorities that
  makes the per-transaction reservation `networkFee + max_allowed_lamports`
  instead of the fee alone. devnet reserves ~9.9M lamports against ~2.04M of real
  ATA rent, so it over-reserves.

Rent is **recoverable, but only because this package makes it so.** klend's
`withdrawIxs` bundle carries no cleanup instructions, so the share ATA was never
closed and its 2,039,280 lamports stayed locked in a zero-share account on every
exit, whoever had paid. `buildShareAccountCloseInstruction`
(`./withdraw-instructions.ts`) closes it when the exit provably empties it and
sends the rent to whoever actually funded it. Two rules that follow:

- **Pass the recorded funder, never the current sponsor.** Rent is paid when the
  account is created and the fee mode can flip before the exit, so `rentRefundTo`
  must come from persisted state. Refunding today's sponsor for rent the customer
  paid takes the customer's lamports. One exception, and `./sdk.ts` implements it:
  when THIS exit creates the account (consolidation's idempotent create), its own
  `rentPayer` funded it moments earlier in the same transaction and the recorded
  value describes an older instance.
- **The close condition is exact, not optimistic.** `CloseAccount` fails on a
  non-zero balance and rides the same transaction as the redemptions, so guessing
  wrong fails the customer's exit rather than merely stranding rent. It takes two
  equalities: the redeemed quantity must match both what the ATA will hold and
  the owner's total across every share account, because closing on an
  emptied-but-not-exited position hands the next entry a stale funder.

Still bounding the decision: `max_allowed_lamports` caps a sponsored transaction
at 4 new ATAs on devnet, and a re-entry after a close pays rent again. Full
rationale and the mainnet conditions live in
`docs/decisions/0002-earn-provider-pluggability.md`.

## Withdrawals are one complete transaction

Every plan also carries required `assetIdentity` with the deposit-token mint and
share mint read from the same live vault state used to build its instructions.
Catalogue metadata drives policy and ledger labels but is not builder truth; the
API must compare both mints before signing so a stale or poisoned row cannot
authorize one asset while the transaction moves another.

`KaminoInstructionPlan.instructions` keeps the provider-neutral `Instruction[]`
shape containing one complete ordered transaction instruction sequence.
`KaminoVaultDirectClient` implements `buildVaultWithdrawal`, so
`supportsVaultWithdraw` answers true.

- The vault's published lookup table is loaded best-effort (`lookup-table.ts`,
  via kit's `fetchAddressesForLookupTables`). When used, its address travels on
  `lookupTables` so the API compiles the final message with compression.
- The API appends the request memo, compiles and signs the final transaction,
  then rejects signed bytes above Solana's 1232-byte limit.
- **The total share quantity is decoded from the instruction bytes**
  (`sharesAmount: u64` behind the `withdraw`/`withdraw_from_available` anchor
  discriminators, pinned to their sha256 derivation by test). The decoded total
  must equal the accepted request exactly or the plan is refused.

## Known gaps (deliberate, and owed to the caller)

- **Withdrawal penalties are not quoted.** Kamino charges
  `max(bps × gross, flat)` **per withdraw instruction**, so a multi-reserve exit
  can pay N × flat. The SDK exposes `getVaultWithdrawPenalties` /
  `ShareExitLiquidityPlan`; until one is wired, this package returns no estimate
  rather than a derived one. A wrong number here is worse than none — same rule as
  the dashboard's "missing renders —, never a fabricated rate".
- **`minSharesOut` is optional and unset by default.** Computing a real floor needs
  the live exchange rate. Passing `"0"` would be the appearance of slippage
  protection without the substance, so the caller computes a floor or passes
  nothing. The API requires one in PRODUCTION for exactly that reason.
- **Withdrawals do not unstake farm-staked shares.** The withdraw builder
  passes no farm state, matching the deposit builder (which never stakes), so
  an SDP-managed position has nothing staked and nothing to unstake. Shares
  staked OUTSIDE SDP must be unstaked outside SDP before they can exit through
  it. The instruction planner still preserves unstake instructions for the day
  farm support arrives.

## Amounts are checked against the MINT, not just parsed

`amounts.ts` (deliberately outside the SDK firewall, so it is unit-testable
without loading klend-sdk) refuses any value finer than its mint can represent,
and returns the canonical form the instruction actually encodes — surfaced as
`KaminoInstructionPlan.accepted`, which is what the ledger should persist.
Trailing fractional zeroes do not add precision (`1.5000000` is representable by
a six-decimal mint); a non-zero sub-atom still fails rather than being floored.

This exists because klend-sdk converts every `Decimal` to mint atoms and
**floors, silently**. Two different bugs hide under that floor: `1.0000009` on a
six-decimal mint is RECORDED as 1.0000009 while 1.000000 moves, and a
`minSharesOut` below one atom becomes `0` — a slippage floor that reads as
protection everywhere and imposes none on chain. Validating the scale rather
than clamping is the point: clamping would make SDP quietly move a different
amount than it was asked for.

## Share balances are read in base units, never `uiAmount`

`readKaminoPosition` computes UNSTAKED shares itself, from
`tokenAmount.amount` (the exact integer string), and takes only the STAKED half
from `vault.getUserShares`. The SDK's own path sums
`parsed.info.tokenAmount.uiAmount` — a JSON **number** — via
`getTokenAccountAmount` (`utils/ata.ts`), so above 2^53 base units the value has
already lost precision and no amount of `Decimal`-wrapping downstream recovers
it. The staked half comes from farm state as an exact `Decimal`, so it is safe
to reuse. Every matching token account is summed; if any returned account lacks
an exact raw amount, the entire position is unreadable rather than silently
under-reported.

An empty portfolio request first calls the SDK's on-chain
`getUserSharesBalanceAllVaults` only to discover candidate vault ADDRESSES. That
helper enumerates the configured kvault program plus the owner's farm and token
accounts, so catalogue admission gates cannot hide an existing holding. Never
return its balance values: they use the same lossy `uiAmount` path and overwrite
rather than sum multiple token accounts. Every candidate is re-hydrated through
`readKaminoPosition`, and exact zeroes are removed only after that read.

## RPC reads are bounded

`rpc.ts` applies a 30-second deadline at the transport boundary shared with
klend-sdk, so vault, reserve, farm, token-account, exchange-rate and slot reads
cannot hold an API worker forever. Caller cancellation is composed with that
deadline and remains distinguishable from a timeout. A portfolio page reads one
shared slot, then hydrates at most four candidate holdings concurrently. An
empty request pays one on-chain program/owner census up front, then fans out only
over vaults for which the SDK found a share-token account or farm position — not
the whole raw registry and not the curated catalogue. Census failures propagate
rather than becoming a false empty portfolio.

## Tests

`vitest run`, and **offline by default** — the repo rule is that package tests
touch no network.

`sdk.smoke.test.ts` is the exception: env-gated (`KAMINO_SMOKE_RPC_URL` +
`KAMINO_SMOKE_SIGNER`), skipped when unset, so CI never runs it. Run it against a
surfpool surfnet forking mainnet — real kvault program, real vault, no mainnet
money at risk:

```bash
KAMINO_SMOKE_RPC_URL=http://127.0.0.1:8899 KAMINO_SMOKE_SIGNER=<64 hex chars> pnpm --filter @sdp/kamino test
```

Fund the signer first with SOL and the vault's deposit token via surfpool's
`surfnet_setAccount` / `surfnet_setTokenAccount` cheatcodes. It proves what the
offline tests cannot: that the emitted instructions simulate, land, and mint
shares the position read then reports.
