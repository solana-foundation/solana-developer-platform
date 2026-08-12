# 0002. Earn provider & curator pluggability

Date: 2026-07-20
Status: Accepted — implemented on `main` (`earn-initial` merged as
`bdb63491`, #831; subsequent amendments are recorded as addenda below)

## Context

Solana Earn (SDP Markets V1) fronts yield strategies through external
vault-infra providers (Veda, Upshift, Perena, Ground today) and surfaces
curator risk frameworks (Gauntlet, Steakhouse, Sentora today). Both lists are
expected to churn: new partners must be insertable with minimal lift, and
existing ones must be enable/disable-able — per environment and per
organization — without breaking existing integrations or trapping customer
funds in a strategy whose provider was switched off.

## Decision

### Three pluggability tiers, by integration weight

1. **Curators — zero code.** A curator is catalogue data, not an integration.
   `risk_metadata.curator` is an open string written during strategy sync
   (ADR 0001 pattern); `EARN_KNOWN_CURATOR_LABELS` in `@sdp/types/earn`
   optionally prettifies known ids. Onboarding a curator requires no
   migration, no type change, no deploy ordering.

2. **Strategies — zero migration.** `source_kind`, `underlying_source`,
   `apy_type`, `liquidity_term` are open TEXT columns validated against code
   registries in `@sdp/types/earn`. Adding a new RWA or DeFi source is a
   registry/catalogue change.

3. **Vault-infra providers — compiler-guided code change.** Adding an id to
   `EARN_PROVIDERS` (`@sdp/types/provider-access`) intentionally breaks the
   build until every `satisfies Record<EarnProviderId, ...>` map is filled:
   the client registry (`EARN_PROVIDER_CLIENTS` in `@sdp/earn`) and the
   availability definitions (`provider-availability.service.ts`). The
   compiler enumerates every registration point, so "a lot of lift" is
   replaced by "follow the type errors". Full checklist:
   - `packages/sdp-types/src/provider-access.ts` — add the id to
     `EARN_PROVIDERS` (entitlement is override-only; there is no tier
     default list to fill).
   - `packages/sdp-earn/src/providers/<id>/client.ts` — subclass
     `StubEarnClient` (`providers/stub.ts`), declaring only the `provider`
     literal and `declaredSupport`; every operation throws `NOT_IMPLEMENTED`
     until the integration overrides it.
   - `packages/sdp-earn/src/index.ts` — register in `EARN_PROVIDER_CLIENTS`
     (+ `package.json` exports entry for the new subpath). Guarded by the
     registry-consistency test in `packages/sdp-earn/src/index.test.ts`.
   - `apps/sdp-api/src/services/provider-availability.service.ts` — one
     line: `<id>: keyPairCredentialDefinition("<Label>", "<ID>")`.
   - `apps/sdp-api/src/types/env.d.ts` (compile-enforced by the helper),
     `turbo.json` `globalEnv`, `scripts/secret-keys.mjs` — declare
     `<ID>_API_KEY` / `<ID>_SANDBOX_API_KEY` (+ Doppler). The latter two are
     guarded by `provider-availability.drift.test.ts`.

   The followable walk-through, with verify steps, lives in the
   [Earn pluggability playbook](../contributing/earn-pluggability-playbook.md).

### Enable/disable without breakage

Independent switches, all runtime-safe:

- **Environment kill switch:** a provider with no credentials configured is
  `configured: false` — hidden from availability and refused at money-in with
  a clean 503. Removing a key disables the provider for that deployment;
  no code change.
- **Org-level entitlement:** earn providers are override-only — the general
  defaults enable none (`createBooleanRecord(EARN_PROVIDERS, [])`), so every
  organization requires an explicit `providerOverrides.earn.<id>` (manual
  activation), unlike ramps which are on by default.
- **Strategy status:** `active | paused | deprecated` gates individual
  strategies without touching the provider, and an operator stop is durable —
  catalogue sync cannot overwrite `paused`/`deprecated`, so an emergency pause
  holds until the status is deliberately written back. See the playbook's vault
  checklist.
- **Feature flag:** the whole `/v1/earn` family sits behind `EARN_ENABLED`.

### Invariants that make disabling safe

- **Money out always beats money off.** Deposits require an *active* strategy
  and the full entitled+configured provider gate. Withdrawals ignore strategy
  status (paused/deprecated stop money in, never money out) and only require
  provider credentials (`assertEarnProviderConfigured`) — a commercial
  disablement can never trap funds. Unwinding credentials for a provider with
  open positions is an operational runbook action, not a config toggle.
- **Fail closed on registry drift.** Strategy rows persist `provider` as open
  TEXT. Dispatch goes through `resolveEarnProviderClient`, which turns an
  unknown/retired id into `PROVIDER_NOT_CONFIGURED` (503) instead of an
  undefined-lookup crash. Provider ids are never reused; retirement means
  deprecating strategies and draining positions, then removing the id.
- **Reads never gate on availability.** The catalogue and the program surfaces
  remain readable regardless of provider entitlement, and the withdrawal
  ledger list carries no provider gate at all (2026-08-11 addendum), so
  dashboards and partner integrations keep working while a provider is off.

## Consequences

- New provider ≈ one contained PR; the type system is the checklist.
- New curator/strategy source ≈ data + optional label, shippable same day.
- Disabling a provider stops new deposits immediately, leaves withdrawals,
  reads and the withdrawal-ledger history untouched, and requires no deploy.
- Deviation to note: the strategy catalogue is platform-global (carries an
  `environment` column) rather than org/project-scoped — see the header of
  migration `0048_earn.sql`.

## Addendum — 2026-08-03 backend hardening

Amendments from the earn-initial backend-tightening pass; the decision above
stands, these tighten how it is enforced:

- **Shared stub base.** The four byte-identical provider stubs collapsed into
  an abstract `StubEarnClient` (`packages/sdp-earn/src/providers/stub.ts`);
  a concrete client now declares only its `provider` literal and
  `declaredSupport`, and an integration lands method-by-method by overriding.
- **Declared support validates the catalogue.** Each client's
  `declaredSupport` (source kinds + deposit-token symbols) is checked by
  `isStrategyWithinDeclaredSupport` (`packages/sdp-earn/src/support.ts`)
  during catalogue sync. The symbol→mint bridge goes through
  `WELL_KNOWN_TOKEN_BY_MINT` and fails closed: unknown or empty mint lists
  are out of support, so drifted snapshots are skipped, never persisted.
- **Checklist steps are now test-enforced.** Registry/`package.json`-export
  consistency: `packages/sdp-earn/src/index.test.ts`. Credential-key
  projections into `turbo.json` and `scripts/secret-keys.mjs`:
  `apps/sdp-api/src/services/provider-availability.drift.test.ts`. The
  availability entry itself shrank to a one-line
  `keyPairCredentialDefinition` call that binds its derived env keys to
  `keyof Env`, making `env.d.ts` drift a compile error.
- **Entitlement corrected to override-only.** Earn no longer participates in
  tier defaults; providers are disabled for every org until an explicit
  `providerOverrides.earn.<id>` (see the enable/disable section above).
- **Naming.** `EarnRuntimeContext.mode` was renamed to `environment` to match
  the rest of Earn (`packages/sdp-earn/src/types.ts`; sole producer
  `apps/sdp-api/src/routes/earn/context.ts`).

## Addendum — 2026-08-03 Ground goes live (portfolio-wallet capability)

Ground is the first provider to move past the stub: a live `listStrategies`
plus a **portfolio-wallet capability** that extends — never widens — the base
contract. The pluggability decision holds; this records how an *optional*
capability slots in without burdening providers that lack it.

- **Optional capability, all-or-nothing guard.** `EarnPortfolioWalletProvider`
  (`packages/sdp-earn/src/types.ts`) extends `EarnVaultProvider` with the
  portfolio surface (wallet create/get, strategy update, deposits page,
  withdrawal preview/create/status, address-book entry). Callers never probe
  individual methods: `supportsPortfolioWallets`
  (`@sdp/earn/capabilities`) is a type guard that requires the *entire*
  method set, so a half-implemented capability is invisible rather than a
  runtime landmine. Providers that don't opt in keep the exact base contract
  — zero added lift, per the original decision.
- **Shared-wallet-per-org model.** One provider wallet per
  `(organization, environment, provider)` — DB-enforced by the unique
  constraint in migration `0049_earn_provider_wallets.sql` and read/written
  through `EarnRepository.getProviderWallet`/`insertProviderWallet`.
  Selecting a strategy re-targets the shared wallet at that single vault
  (create on first use, `updatePortfolioStrategy` afterwards); positions are
  read live from the provider and rendered as a flat holdings list. (The
  curator-first step and curator grouping were removed; V1 caps each token
  group at one allocation entry — see the 2026-08-11 single-vault addendum.)
- **Solana-only surface.** The snapshot exposes only the wallet's Solana
  deposit address (`solana_devnet` sandbox / `solana` production);
  withdrawals and previews pin `destinationChain` to the environment's Solana
  rail. Yield sources on other chains remain valid catalogue entries — the
  provider routes internally; their chain is metadata.
- **Funding is deposit-address, not custody signing.** V1 funds the wallet by
  surfacing its Solana deposit address and tracking deposits via the
  provider's deposits API — no SDP-side transaction building or signing.
- **Exit safety preserved.** Portfolio withdrawals gate on
  *configured*, not *available*: a missing API key fails closed with
  `PROVIDER_NOT_CONFIGURED` before any request, while a commercial
  disablement (entitlement off) still lets money out. `buy_only` yield
  sources are excluded from the catalogue outright — listing one would let
  deposits into a source that can't sell, i.e. trap funds.
- **Declared support narrowed.** Ground's `declaredSupport` is now
  USDC/USDT (USDG dropped); deposit tokens with no known cluster mint are
  skipped, so USDT is effectively production-only.

Operational checklists (provider / vault / category / custodian) live in the
[Earn pluggability playbook](../contributing/earn-pluggability-playbook.md).

## Addendum — 2026-08-04 Markets/Earn flag hierarchy

The single `EARN_ENABLED` switch listed under enable/disable above is now a
two-level hierarchy, because Earn ships as a sub-module of Markets and the
whole module has to be able to go dark in one move:

- **Parent and child.** `MARKETS_ENABLED` gates the entire Markets module;
  `EARN_ENABLED` gates the Earn sub-module inside it. Earn requires **both**,
  so clearing the parent darkens every Markets surface at once. Both default to
  **false** everywhere — Markets is pre-release and must stay dark in deployed
  environments until explicitly switched on.
- **One name per flag, shared by both apps.** `sdp-api` and `sdp-web` read the
  same unprefixed variable names (the `PRIVATE_CHANNELS_ENABLED` pattern — the
  other sub-module flag). There is no `NEXT_PUBLIC_*` twin: the bespoke web
  helper that used one (`apps/sdp-web/src/lib/earn-feature.ts`) is deleted,
  along with its `development` default-on behavior.
- **API: the hierarchy lives in one function.** `isEarnEnabled`
  (`apps/sdp-api/src/lib/feature-flags.ts`) requires `isMarketsEnabled(env)`
  before it reads `EARN_ENABLED`. Callers (`routes/earn/index.ts`,
  `cron/runner.ts`) hand it `env` and check nothing else — a second Markets
  check at a call site is drift, not defence in depth.
- **Web: declared flags, gated by route segment.** Both flags are declared in
  `apps/sdp-web/src/flags.ts` (`markets` / `earn`, `flagDefault(..., false)`),
  resolved server-side in the dashboard layout, and enforced by `notFound()` in
  segment layouts — `dashboard/markets/layout.tsx` wrapping
  `markets/earn/layout.tsx`, so segment nesting reproduces the hierarchy and
  pages hold no flag checks.
- **Not an exit-safety lever.** These flags are pre-release module visibility:
  with the parent off, `/v1/earn` 403s reads and withdrawals alike. They are
  not how you stop a provider that holds customer funds — that remains the
  org entitlement override, which by the invariants above keeps money-out
  working.

## Addendum — 2026-08-11 Ledger vs live: positions read live, withdrawals get a ledger (PRO-1628)

The decision above stands; this settles the open "ledger vs live" question and
prunes the surfaces the answer makes false. The governing principle, applied
per surface:

> **SDP ledgers what SDP initiates; SDP reads live what the provider observes.**

- **Positions and balances are live-only, permanently.** Every balance surface
  in the platform reads live (custody, payments, private channels — which
  states it as doctrine); Earn now matches. `earn_positions` is dropped
  (migration `0055`) along with `GET /v1/earn/positions` — the table never had
  a writer and a partner could mistake its empty ledger for authoritative.
- **Withdrawals — the one money movement SDP initiates — get the row every
  other money movement already has** (`payment_transfers` precedent):
  `earn_program_withdrawals`, written at intent and advanced by guarded
  compare-and-swap on every observation
  (`services/earn-withdrawal-ledger.service.ts` owns the canonical transition
  matrix; terminal statuses appear in no source list, so regression is
  unrepresentable). Listed at `GET /v1/earn/program/withdrawals`. The old
  strategy-era `earn_movements` is dropped rather than retrofitted — it was
  position-scoped with base-unit amounts, the wrong shape for portfolio-level
  USD withdrawals; PRO-1634 redesigns a movements ledger against real flows if
  the execution era arrives.
- **Deposits stay live.** A deposit is a customer-initiated transfer SDP never
  sees at intent time; observing it from chain is indexer-shaped work (a stated
  non-goal). Deposits surface through the live program snapshot and enter a
  ledger only when SDP initiates them (execution era).
- **Idempotency is now two-layer.** The derived withdrawal request id anchors
  an SDP intent row — unique per `(wallet_id, request_id)`, wallet-scoped
  because every project in an environment shares the program wallet — with a
  payload fingerprint that 409s key-reuse before any provider call. The
  provider's own request-id dedupe remains the backstop that closes the crash
  window between our insert and its acceptance.
- **Exit safety.** The intent insert is request-path bookkeeping like
  payments', not an availability gate; withdrawal endpoints still gate on
  credentials alone. A ledger write that fails AFTER provider acceptance never
  fails the response (money moved; the write retries, then logs
  `earn_ledger_write_failed`). Heal semantics are narrow and honest: the
  detail poll heals only rows that already carry `provider_reference`; a
  ref-less row heals via a same-key create retry or the ledger sweep — never
  fuzzy matching. **Hard requirement on the sweep ticket:** a ref-less
  `requested` row can also be a definitively-rejected intent the caller was
  synchronously told failed (a provider 4xx rethrows and leaves the row
  untouched); before the sweep re-drives such a row it must discriminate
  transport failures from definitive rejections — or verify with the
  provider — so it can never execute an intent the caller abandoned and
  re-issued under a new key. The ledger LIST carries no provider gate at all:
  the audit trail outlives credential removal and entitlement disablement.
- **`partially_completed` is terminal by convention** (shared
  `EARN_TERMINAL_WITHDRAWAL_STATUSES` in `@sdp/types`, one declaration for API
  and dashboard). If a provider ever advances it, the live GET keeps serving
  provider truth while the ledger row stays put.
- **NAV is unpublished** — executing the unpublish branch of the NAV decision:
  `earn_nav_snapshots` had no production writer, its endpoint no dashboard
  proxy, and `getNav` no implementation in any provider, so the table,
  endpoint, contract method and math module are removed. The rescoped NAV
  ticket decides source of truth and rebuilds when a real consumer exists.
- **The provider contract is slimmed to what is real**: `provider` +
  `declaredSupport` + `listStrategies`, plus the optional portfolio and
  withdrawal-approval capabilities. The never-implemented per-strategy
  quote/execution members (and their permanently-501 `/deposits/quote`,
  `/withdrawals/quote` routes) live in git history until PRO-1634 gives them a
  consumer. The withdrawal-approval capability and
  `createPortfolioAddressBookEntry` are KEPT despite having no route: they are
  the exit-safety escape hatch for approval-parked withdrawals and the
  provider-enforced destination-whitelisting seam — both owned by the
  production-enablement pre-flight (PRO-1635).
- **Forensics rule for money tables** (this codifies existing practice):
  money-movement tables carry write-only provisioning attribution —
  `project_id`, `created_by`, `initiated_by_key_id` — read by humans during
  incident forensics, not by wire surfaces. `initiated_by_key_id` is bare TEXT
  with no FK, matching every sibling ledger.
- **Amended above:** the "Reads never gate on availability" invariant no longer
  names positions/movements/NAV (their read surfaces are replaced by the
  program snapshot + the withdrawals ledger), and the disabling consequence now
  includes ledger history.

## Addendum — 2026-08-11 Single-vault V1: one allocation entry per token group (PRO-1667)

**Decision.** Earn V1 sells deposit and withdraw into a single vault per
deposit token. `PUT /v1/earn/program` caps each token group at ONE allocation
entry (the group cap in `apps/sdp-api/src/routes/earn/schemas.ts`); the
sum-to-100 rule then pins that entry to `pct: 100`. The dashboard workspace
stopped rendering per-holding share percentages. The audit surface now matches
what V1 ships.

**What is deliberately kept, dormant.** The weighted wire shape (arrays of
`{yieldSourceId, pct}` per token group), the provider contract
(`updatePortfolioStrategy`, the `weightBps` types), and Ground's
strategy-update client are untouched — the API and provider side of
re-enabling weighted portfolios post-V1 is a validation-only relaxation of
the group cap, never a wire or provider-contract change. That is the server
half only: the dashboard ships no weight authoring (the weight editor was
removed before V1) and no share display (removed by this change), so weights
returning as a product carries that dashboard work with it — relaxing the
cap alone would recreate the exact API/dashboard mismatch this decision
removes. The update branch's in-place full re-target
(switching vaults at 100%) also stays; whether it survives once program
multiplicity exists is PRO-1670's design decision.

**Multiplicity is not cut.** Concurrent exposure to several strategies
arrives as separate single-vault programs — one per strategy (PRO-1670, which
relaxes the 0049 one-per-org constraint). This addendum caps allocations
*within* a program; multiplicity lives between programs.
