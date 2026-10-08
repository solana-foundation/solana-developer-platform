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

`src/sdk.ts` is the only module that may import `@kamino-finance/klend-sdk` (its
`dist/` subpaths included: the farm reader comes from `dist/classes/farm_utils.js`,
which the SDK index does not re-export; keep the `.js`, the SDK has no exports
map and plain Node ESM needs it) or `decimal.js`. Everything crossing this
package's surface is `@solana/kit` 6.8,
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

Rent stays in the share ATA after an exit. A pre-build read and a
recorded creation claim cannot prove who paid for its current instance:
idempotent creates can race, and the owner can close and recreate an account
outside SDP. `rentRefundTo` therefore cannot authorize an automatic refund.
The empty account remains owner-controlled and its rent remains recoverable
through an explicit owner-authorized close outside SDP. The SDP reclaim action
is tracked in [#2166](https://github.com/solana-foundation/solana-developer-platform/issues/2166).

The SDK's unconditional full-exit `CloseAccount` is stripped and SDP appends no
share-account close. Even a same-transaction creation can use lamports sent to
the address beforehand, so creation alone does not prove one payer funded all
its rent. Newly created accounts and partial exits retain rent too.

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
`supportsVaultWithdraw` answers true. It also implements `quoteVaultDeposit`
and `quoteVaultWithdrawal` (`quoteKaminoDeposit` / `quoteKaminoWithdraw` in
`sdk.ts`; the arithmetic and issue rules live in the firewall-free
`quotes.ts`), so both quote guards answer true. Quotes are reads: they build
nothing and return blocking conditions as `issues` (`DEPOSIT_CAP_EXCEEDED`,
`DEPOSIT_BELOW_MINIMUM`, `ZERO_SHARES_OUT`,
`INSUFFICIENT_WITHDRAWAL_LIQUIDITY`, `ZERO_ASSETS_OUT`,
`BELOW_MINIMUM_WITHDRAWAL`) rather than throwing. The deposit minimum compares
the amount remaining after crank funds with the vault's live
`minDepositAmount`; its message reports the minimum request inclusive of those
crank funds.

- The vault's published lookup table is loaded best-effort (`lookup-table.ts`,
  via kit's `fetchAddressesForLookupTables`). When used, its address travels on
  `lookupTables` so the API compiles the final message with compression.
- The API appends the request memo, compiles and signs the final transaction,
  then rejects signed bytes above Solana's 1232-byte limit.
- **The total share quantity is decoded from the instruction bytes**
  (`sharesAmount: u64` behind the `withdraw`/`withdraw_from_available` anchor
  discriminators, pinned to their sha256 derivation by test). The decoded total
  must equal the accepted request exactly or the plan is refused.

## Known gaps

- **Deposit amounts require finalized receipts.** A deposit encodes a maximum,
  and the program can accept less. `deposit-receipt.ts` validates the recorded
  signature, cluster program, owner, vault, both mints, maximum and share floor,
  then reads token transfers and minted shares inside that deposit invocation.
  It does not use the wallet's net balance, which can include swap proceeds.
  Missing or unfamiliar metadata stays unvalued. API migration 0121 adds receipt
  provenance; reads ignore historical guesses and repair retries durably.
- **Exit quotes are conservative, and exits still carry no on-chain floor.**
  `quoteKaminoWithdraw` prices an exit through the SDK's `ShareExitLiquidityPlan`
  with the effective penalties (`max(vault, global config)` per field). The SDK
  charges the penalty once on the aggregate, while the program charges
  `max(bps x gross, flat)` **per withdraw instruction**, so for an exit split
  across N reserves the quote subtracts a further `(N - 1) x (flat + 1)` base
  units and can only understate what lands (`conservativeExitNetBaseUnits`).
  `min_withdraw_amount` is a per-instruction guard on the NET amount, so the
  quote checks every planned leg (the idle-liquidity leg plus one per reserve)
  and reports `BELOW_MINIMUM_WITHDRAWAL` when any leg is at or below it, not
  only when the aggregate is.
  The kvault withdraw instruction takes only a share amount, so `assetsOut`
  informs the caller and nothing enforces it on chain; the Kamino slippage
  policy leaves the exit floor-less. `buildVaultWithdrawal` explicitly refuses
  a supplied `minAmountOut` with `WITHDRAW_REFUSED` before any RPC or build.
  It must never silently drop a requested protection.
- **The deposit cap clamp is detected, not read.** klend-sdk's
  `estimateSharesFromTokens` silently clamps to the remaining cap the way the
  program does. `observeDepositPricing` replicates its AUM inputs and
  `detectDepositCapClamp` reports `DEPOSIT_CAP_EXCEEDED` only when the SDK's
  estimate matches the clamped prediction and differs from the uncapped one, so
  a replica that drifts can withhold the issue but never invent it.
- **`minSharesOut` stays optional at the package boundary.** Computing a real
  floor needs the live exchange rate. Passing `"0"` would be the appearance of
  slippage protection without the substance, so the builder never invents it.
  SDP's Kamino policy is an explicit 10 bps wherever the program can enforce
  one; the caller derives the exact floor from the live quote and supplies it.
- **Devnet's kvault program cannot enforce a floor.** klend-sdk turns any
  `minSharesOut` into `deposit_with_min_shares_out`, and Kamino's DEVNET build
  (`devkRng…`, IDL 2.0.1, 20 instructions; measured from the on-chain IDL
  2026-09-18) does not implement it, only mainnet's (IDL 2.2.2, 26) does. The
  chain answers Anchor 101 `InstructionFallbackNotFound`, after the caller has
  been shown a floor. Three layers, mirroring the program-id trap:
  `KAMINO_KVAULT_DEPOSIT_FLOOR_SUPPORT` (@sdp/types) is the measurement;
  `buildKaminoDepositPlan` refuses a floor for such a cluster BEFORE any read
  (`DEPOSIT_REFUSED`, the API's 400); `assertPlanInstructionsSupported`
  (guards.ts, run inside `assertPlanTargetsCluster`) re-checks the OUTPUT by
  discriminator so an SDK that started emitting the variant unasked fails here.
  `earnDepositSlippagePolicy` reads the same table, so a devnet Kamino row
  publishes `depositSlippage: null` and no consumer asks for a floor there.
  When Kamino upgrades devnet, re-read the IDL and flip the table entry.
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

`readKaminoPositions` computes UNSTAKED shares itself, from
`tokenAmount.amount` (the exact integer string), and takes only the STAKED half
from klend-sdk's own farm reader (`getUserSharesInTokensStakedInFarm`, the one
`vault.getUserShares` calls), for the same farms. The SDK's own unstaked path
sums `parsed.info.tokenAmount.uiAmount`, a JSON **number**, via
`getTokenAccountAmount` (`utils/ata.ts`), so above 2^53 base units the value has
already lost precision and no amount of `Decimal`-wrapping downstream recovers
it. The staked half is farm state scaled through a JS number (farms-sdk
`scaleDownWads`), so it is exact only below 2^53 lamports; SDP itself never
stakes. Every matching token account is summed; if any returned account lacks
an exact raw amount, the entire position is unreadable rather than silently
under-reported.

An empty portfolio request first calls the SDK's on-chain
`getUserSharesBalanceAllVaults` only to discover candidate vault ADDRESSES. That
helper enumerates the configured kvault program plus the owner's farm and token
accounts, so catalogue admission gates cannot hide an existing holding. Never
return its balance values: they use the same lossy `uiAmount` path and overwrite
rather than sum multiple token accounts. Every candidate is re-hydrated through
`readKaminoPositions`, and exact zeroes are removed only after that read.

## RPC reads are bounded

`rpc.ts` applies a 30-second deadline at the transport boundary shared with
klend-sdk, so vault, reserve, farm, token-account, exchange-rate and slot reads
cannot hold an API worker forever. Caller cancellation is composed with that
deadline and remains distinguishable from a timeout. Both clients send a read
once more, immediately, when its pooled keep-alive socket died before any response
(`withReadSocketRetry` from `@sdp/rpc`); sends, simulations and every other
failure surface unchanged. A portfolio page reads one
shared slot, then reads at most four share-account balances at a time (see
"Position reads batch and share requests"). An
empty request pays one on-chain program/owner census up front, then fans out only
over vaults for which the SDK found a share-token account or farm position — not
the whole raw registry and not the curated catalogue. Census failures propagate
rather than becoming a false empty portfolio.

The API injects a read/build runner that retries transient nested RPC failures
against genesis-verified alternatives within one shared workflow deadline.
Explicit cluster pins stay pinned. This runner never signs or broadcasts, and
a stalled primary can exhaust the deadline before fallback. `VAULT_UNREADABLE`
preserves its cause; an unreadable account alone does not prove a wrong cluster.

## Position reads batch and share requests

Every value is read live on every call; nothing is cached. A page is the slot,
then ONE `getMultipleAccounts` for all its vault states, then ONE for the union
of their reserves and the owner's farm user states, alongside one
`getTokenAccountsByOwner` per vault. klend-sdk decodes those batched bytes
through a read-only RPC over the batch (`readAccountBatch`), so its owner,
discriminator and staked-share code runs unchanged; a read outside the batch
fails closed. A vault with no configured farm reads no farm state. If the union
read fails, the farm user states are re-read alone and each vault's reserves on
their own (four at a time), so the share count survives and only a vault whose
own reserve read failed goes without a value.

`createKaminoReadRpc` keeps one transport per endpoint that shares identical
in-flight requests, so owners hydrated together read the slot, a vault and
(farm-less) its reserves once. Only `getSlot`, `getAccountInfo`,
`getMultipleAccounts` and `getTokenAccountsByOwner` are shared; every other
method (sends, simulations, blockhashes) passes straight through. A caller joins
only a request sent after its read floor (`packages/sdp-rpc/CLAUDE.md`, "Read
floors") and under 2 s ago (`KAMINO_SHARED_READ_JOIN_WINDOW_MS`), so a stalled
request never captures later callers: they send their own, and the old one
aborts once its last joiner's 30 s deadline has passed. It sits BELOW
`withRpcReadContext`: a minimum-slot read never joins an unscoped one, and every
consumer validates the context itself. The socket retry sits below the sharing,
so a re-send serves every joiner with the scoped payload. Builds and quotes stay
on `createKaminoRpc`.

Builds and quotes carry what they need in their reserve read: the share ATA
(deposit build, `createsShareAccount` from its decoded owner and mint), the
global config (withdraw quote and build) and the lookup table (withdraw build,
`jsonParsed` so the table comes back parsed while accounts without an RPC
parser fall back to base64). A withdraw that needs no consolidation hands
klend-sdk the ATA balance the share-account read returned instead of letting
it read the ATA again. Devnet, 2026-10-02: two owners in one farm vault went
from 12 requests to 6 and a withdraw build from 7 to 4, values identical.

The page `getSlot` stays: pricing at the reserves read's context slot would
move values (about 564 base units per slot on a 1M-share holding with borrows).

## Tests

`vitest run`, and **offline by default** — the repo rule is that package tests
touch no network.

`sdk.smoke.test.ts` is the exception: env-gated by `KAMINO_SMOKE_RPC_URL` and
skipped when unset. It requires a loopback Surfpool fork, generates a fresh
ephemeral signer, and funds it using local cheatcodes. No private key is needed.
Run it against a mainnet fork:

```bash
KAMINO_SMOKE_RPC_URL=http://127.0.0.1:8899 pnpm --filter @sdp/kamino exec vitest run src/sdk.smoke.test.ts
```

The default vault is Steakhouse USDC. Override `KAMINO_SMOKE_VAULT` for another
vault. A devnet fork also needs `KAMINO_SMOKE_CLUSTER=devnet` and a devnet vault
address. The fixture currently funds 100 million token base units and deposits
25 whole units, so use a six-decimal deposit mint.

The tests verify an impossible deposit floor fails with the named program
error where supported, then lands a deposit and partial and full withdrawals.
They check exact share changes, returned deposit tokens, retained account rent,
lookup-table compilation and transaction size. Mainnet and devnet fork runs
use synthetic funds; provider program code and vault data are not patched by
cheatcodes. Upstream RPC failures while Surfpool fetches accounts can still
prevent a run from completing.
