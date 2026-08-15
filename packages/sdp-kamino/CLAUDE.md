# @sdp/kamino — agent notes

Kit-native deposit/withdraw **instruction building** for Kamino K-Vaults, plus
the live position read. It builds unsigned plans and reads chain state; it never
signs, never submits, never touches a database, and holds no credential —
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
  Both differ from klend-sdk's own default of 450. Re-measure rather than adjust
  by feel.
- **`KAMINO_KVAULT_PROGRAM_IDS`** — the one address that DIFFERS per cluster.
  Mainnet's id also exists on devnet with zero accounts, so aiming at the wrong one
  yields a confident empty result rather than an error.
- **klend and farms are the SAME id on both clusters** — verified deployed and
  executable on each, explicitly, because a farms id that differed per cluster
  would fail exactly the way kvault does. Both are still expressed as per-cluster
  records so a future divergence is a data change here, not a hunt through callers.

## `payer` is NOT the transaction fee payer

klend-sdk's `payer?: TransactionSigner` is the **rent payer for created ATAs**,
embedded in the instruction accounts as writable+signer. SDP's Kora path is
different machinery: it sets the fee payer at compile time and signs post-compile
via `signAsFeePayer(bytes)`. Naming a sponsor signer as `payer` would quietly bill
it for share-ATA rent — a spend its `FeePayerPolicy` may refuse and which
`sponsorship-budget.service.ts` does not account for. The field is `rentPayer`
here for exactly that reason, and it defaults to the owner.

## Plans are transaction-sized BATCHES

`KaminoInstructionPlan.instructions` is `Instruction[][]`, one entry per
transaction — not a flat list. A multi-reserve exit emits several withdraw
instructions each carrying the vault's full reserve remaining-accounts list, and
can exceed Solana's 1232-byte packet; Kamino publishes a per-vault lookup table
(`SyncVaultLUTIxs`) precisely for this. Handing back a flat list would make the
caller discover that at `compileTransaction`, far from the code that could fix it.

The unstake → withdraw → post sequence stays in ONE batch deliberately: it must
land atomically, since unstaking without the withdraw leaves the position in a
state nobody asked for. If that stops fitting, the fix is the lookup table, not
splitting the batch.

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
  nothing.
- **`lookupTables` is always empty today.** The field exists so callers compile
  against the right shape; populating it from Kamino's per-vault LUT is the fix
  when a plan stops fitting.

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
