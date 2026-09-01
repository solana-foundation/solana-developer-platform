# @sdp/veda — agent notes

Kit-native deposit **instruction building** for Veda's SVM vaults, plus the live
position read. It builds unsigned plans and reads chain state; it never signs,
never submits, never touches a database, and holds no runtime credential —
Veda's vaults are reached entirely on chain. Signing and submission belong to
the API, which owns custody.

Read `packages/sdp-earn/CLAUDE.md` for the catalogue side (what a Veda vault row
IS) and ADR 0002 for the pluggability invariants. `packages/sdp-kamino` is the
precedent this package mirrors, and the differences from it are the interesting
part of this file.

## THE BLOCKER: SDP does not know Veda's addresses

`VEDA_DEPLOYMENTS` in `@sdp/types/veda-programs` is `null` for both clusters, so
**every chain call in this package fails closed with `DEPLOYMENT_NOT_CONFIGURED`
and nothing here has ever run against a live vault.** That is deliberate, not an
oversight:

- The `address` baked into each Anchor IDL inside `@vedatech/svm-sdk`
  (`5J76xGGXn5op…`, `Cchro8d7bN5X…`, `FSZPGBfPWb6f…`) — MEASURED 2026-08-19 with
  `getAccountInfo` against both public RPCs: **none of the three exists on
  either cluster.** They are the source repository's `declare_id!` defaults.
- Veda's integration document names three different addresses, and SDP has only
  truncated prefixes of them.

The SDK is built for this: `createVedaClient` takes every program address at
runtime and, per its README, "does not include default addresses or infer one
program from another". The addresses are deployment CONFIGURATION Veda supplies.

**Filling them in is a pure data change** in `@sdp/types/veda-programs`. Before
doing it, get Veda to confirm, per cluster: the three program addresses, the
vault-state address(es) SDP should catalogue, and whether devnet and mainnet
really share addresses (the document implies they do). Then run
`src/sdk.smoke.test.ts`, which is the only thing in this repository that can
prove the integration end to end — see "Tests" below.

## The kit-version firewall

`@vedatech/svm-sdk` is built against `@solana/kit` **7.0.0**; this repo pins
**6.8.0**, and pnpm nests the SDK's own copy (the tree now carries four kit
majors — 2.3.0 via klend-sdk, 5.5.1, 6.8.0, 7.0.0). `src/sdk.ts` is the only
module that may import it. Everything crossing this package's surface is
`@solana/kit` 6.8, `@sdp/types`, or a **decimal string**.

Every cast at that seam is a structural re-label, not a coercion: kit's
`Instruction` is a plain object with `programAddress`, a numeric `AccountRole`
and `Uint8Array` data in both majors, and the client converts to base64 strings
and numbers before anything leaves.

`sdk-construction.test.ts` greps this package's own source for the rule, because
it is invisible to the type checker.

## It is the SDK's only owner, and that is enforced

`@vedatech/svm-sdk` is public on npm (it began private; the scope opened during
this integration), but it stays confined to this one package —
`scripts/check-veda-dependency-boundary.mjs` enforces it. The confinement is
about the kit-version firewall above and about pinning the SDK's IDL/ABI
assumptions to exactly one import site, not about credentials: a second owner
would put another nested kit major in front of code that never asked for one.

## Money in requires a way out

`assertVedaVaultUsable` runs `validateDeployment()` **and**
`validateCompatibility({ requireQueue: true })` before any deposit is built.
Requiring the withdrawal queue on the DEPOSIT path looks like the wrong
capability to demand until you read it as ADR 0002's exit-safety rule: the queue
is Veda's durable exit, and SDP will not open a position in a vault whose exit
infrastructure is not configured and wired to that vault.

It gates only the way IN. The catalogue read, position reads and any future exit
path never call it, so it can never trap funds — only decline to create them.

Verdicts are cached per (cluster, endpoint, vault) for ten minutes.
**Failures are never cached**: an incompatible or unreachable deployment is
re-checked, not remembered.

## The INSTANT exit is implemented; the QUEUE deliberately is not

`VedaVaultDirectClient` implements `buildVaultWithdrawal` (ADR 0003 — "instant
lands first, and alone"): burn shares, receive the vault asset, one
transaction, carried by the same `POST /vault-withdrawals` movement model
Kamino uses. `quoteVaultWithdrawal` (`supportsVaultWithdrawQuote`) is the read
the exit floor derives from, exactly as `quoteVaultDeposit` feeds the deposit
floor; `minAmountOut` is required for the same reason `minSharesOut` is.

The exit build deliberately does NOT run `assertVedaVaultUsable`: that check
demands the withdrawal QUEUE and exists to stop money going IN. The vault's
own refusals — `RESTRICTED_REDEMPTION` when a withdraw authority is set,
`SHARE_LOCKED` inside the post-deposit lock window — surface as
`WITHDRAW_REFUSED` with the SDK's own sentence, which the API maps to a 400.

Veda's OTHER exit, the request → fulfil → cancel queue, stays unimplemented:
its lifecycle is settled by a solver Veda operates and does not fit the
movement model, so it waits on its own capability and schema (ADR 0003 §4).
Implementing only the instant half is not auto-selecting a route — the caller
asked for an immediate redemption and gets exactly that or a typed refusal;
SDP never silently substitutes the queue.

## Slippage protection is never invented

`minSharesOut` is **required** on this client, unlike Kamino's, where it is
optional. Veda's SDK refuses an implicit tolerance — `buildDeposit` throws
`SLIPPAGE_PROTECTION_REQUIRED` without either a floor or a bps tolerance — and
SDP passes that refusal through rather than papering over it with a default.
`slippageBps` appears nowhere in this package, and a source test asserts it.

Note the API only requires a floor in PRODUCTION; for Veda it is required in
every environment, which is why the refusal is a typed `INVALID_AMOUNT` raised
before any chain work.

## Amounts are checked against the MINT, not just parsed

The SDK takes atomic `bigint`s, so SDP owns the decimal→atoms conversion and the
only two options are refuse or round. `amounts.ts` (deliberately outside the
firewall, so it is unit-testable without loading the SDK) refuses any value
finer than its mint can represent and returns the canonical form the instruction
actually encodes — surfaced as `VedaInstructionPlan.accepted`, which is what the
ledger persists.

Two bugs hide under rounding: a deposit of `1.0000009` on a six-decimal mint
would be RECORDED as 1.0000009 while 1.000000 moved, and a `minSharesOut` below
one atom would become `0` — a floor that reads as protection everywhere and
imposes none on chain.

The deposit mint's decimals are read from the MINT ACCOUNT (`mint.ts`), not from
`WELL_KNOWN_TOKEN_BY_MINT`: the number that decides how many atoms a decimal
becomes has to be the mint's own.

## The vault asset is resolved by IDENTITY, and ambiguity is REFUSED

`EarnVaultDepositInput` and `EarnVaultPositionInput` carry no mint — the
catalogue row does, and the API compares the plan's/snapshot's identity against
it — so this package must arrive at the same asset the catalogue admitted. It
does that by applying the same predicate (`isVedaDepositMint(mint, cluster)`,
in `@sdp/types` precisely so both sides share one copy) to the same source: the
vault's own configured assets. The predicate is CLUSTER-EXACT mint membership,
never a symbol comparison — mainnet USDC and devnet USDC share a symbol but are
different mints, and matching by symbol would spend or value against an account
that does not exist on the chain in play.

Resolution deliberately IGNORES `allow_deposits`, because both money directions
share it and only one may consult that flag: a position read gated on it would
blank a holder's portfolio the moment Veda paused deposits — a READ consuming a
money-in gate, which ADR 0002 forbids. The DEPOSIT path re-checks the flag on
the resolved asset and refuses with `DEPOSIT_REFUSED`, which the API maps to a
400 carrying the sentence.

If more than one asset matches, the call FAILS. While SDP declares one deposit
symbol there can be at most one per cluster, and "pick the first" is the kind of
silent choice that spends the wrong token. Widening
`VEDA_DEPOSIT_TOKEN_SYMBOLS` therefore means carrying a mint on the provider
contract first.

## `owner` is the rent payer, not the fee payer

Veda's `buildDeposit` creates the owner's share account and the vault's asset
account idempotently, with the owner as `payer` — embedded in the instruction
accounts as writable+signer. That is ATA rent, a real spend separate from the
transaction fee, which SDP's Kora path sets at compile time and signs
post-compile. No sponsor address is accepted here for that reason.

## Positions are read in base units, and the valuation may be absent

`getUserPosition` returns an exact atomic `bigint` for the share balance —
never a JSON `uiAmount`, which loses value above 2^53 base units.

`tokenValue` comes from `previewWithdraw`, so the figure is the vault's own
accounting including its oracle and any withdraw premium, rather than
arithmetic this package invents on top of a raw exchange rate. That makes it a
REDEEMABLE value, which is the conservative one to show a holder. The valuation
is allowed to fail INDEPENDENTLY of the share read: a stale oracle or a disabled
withdrawal asset makes the VALUE unknown without making the HOLDING unknown, and
the caller renders "—" rather than a fabricated number.

An empty reference list reads every vault SDP has CONFIGURED. Veda's SDK
publishes no vault discovery and there is nothing to discover: unlike Kamino's
permissionless registry, a Veda vault reaches SDP only by being named in
`VEDA_DEPLOYMENTS`.

## Compliance approvals are not implemented

A Veda vault may run in compliance mode, where a deposit needs an Ed25519-signed
approval from Veda's compliance service placed immediately before the deposit
instruction. v1 does not implement that flow: the SDK's
`COMPLIANCE_APPROVAL_REQUIRED` maps to this package's error of the same name and
the build fails. Implementing it is a deliberate later decision — it needs a
credentialed call to a Veda service, which would also make this the first Veda
surface that is not purely on-chain.

The Ed25519 program is nonetheless in the cluster allowlist, so a future
approval-carrying plan is not rejected by the guard for the wrong reason.

## RPC reads are bounded

`rpc.ts` applies a 30-second deadline at the transport boundary shared with the
SDK, so vault, asset, oracle, mint and position reads cannot hold an API worker
forever. A deposit build fans out over several of those. The API additionally
injects its own absolute vault deadline through the client's operation runner.

## Tests

`vitest run`, and **offline by default** — the repo rule is that package tests
touch no network.

`idl-layout.test.ts` earns its place: it recomputes `@sdp/earn`'s hand-written
`BoringVault` offset table from the committed IDL's own field order, and checks
the committed IDLs against the SDK's shipped copies AND their recorded SHA-256s.
`@sdp/earn` cannot do this itself — it may not depend on the SDK — so a silent
Veda ABI change would otherwise become a silently wrong share mint on a
customer's row. If Veda changes the ABI, this fails on the next `pnpm install`.

`sdk.smoke.test.ts` is the exception to the offline rule: env-gated, skipped
when unset, so CI never runs it. It takes its deployment from the environment
because `VEDA_DEPLOYMENTS` is empty, and it is the only thing that can prove the
integration works.

```bash
VEDA_SMOKE_RPC_URL=https://api.devnet.solana.com \
VEDA_SMOKE_VAULT_PROGRAM=<address> VEDA_SMOKE_QUEUE_PROGRAM=<address> \
VEDA_SMOKE_HOOK_PROGRAM=<address> VEDA_SMOKE_VAULT=<vault-state address> \
VEDA_SMOKE_OWNER=<wallet address> \
pnpm --filter @sdp/veda test
```

DEVNET only. Veda's own checklist requires their separate approval for any
value-moving mainnet test, and `VAULT_DIRECT_DEPOSIT_ENVIRONMENTS` is
sandbox-only for the same reason.
