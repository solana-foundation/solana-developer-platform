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
- **Surfacing (2026-08-14 addendum):** `EARN_PROVIDER_SURFACING` declares which
  registered providers SDP currently OFFERS. An un-surfaced provider keeps its
  code, credentials, crons and catalogue rows, but its strategies vanish from
  every public read and `POST /programs` refuses it. This is the *product*
  switch — the four above are deployment and customer switches — and it is the
  only one that no per-organization override can lift.

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
  Surfacing is the one exception, and only for the *catalogue* read: an
  un-surfaced provider's strategies are hidden, while every route that reads or
  exits an existing program stays open (2026-08-14 addendum). Hiding a shelf
  nobody may buy from is presentation; hiding a position someone holds would be
  hiding their money.

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
- **Shared-wallet-per-org model.** *(Superseded — see the 2026-08-11
  many-programs addendum: an organization now holds N programs, and the
  uniqueness moved onto the provider wallet itself.)* One provider wallet per
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

## Addendum — 2026-08-11 Many programs per organization (PRO-1670)

The **Shared-wallet-per-org model** bullet in the 2026-08-03 addendum is
superseded. Composed with the single-vault cap decided the same day, one program
per `(organization, environment, provider)` meant a customer could hold exactly
one strategy and had no path to a second — the multiplicity that addendum
promised had nowhere to live. It now lives between programs.

- **N programs per (organization, environment, provider).** Each is still one
  provider wallet pinned to one vault, and nothing rebalances across them:
  moving money between programs is an explicit withdraw-then-deposit. A program
  is addressed by its own SDP id (`EarnProgram.id`, first field of the
  envelope); `provider` survives only on the create body and as a list filter,
  because the row already names it and a caller-supplied provider that
  disagreed with the row would have no sensible answer.
- **The uniqueness moved rather than being dropped.** Migration
  `0056_earn_multi_program.sql` drops
  `earn_provider_wallets_org_environment_provider_key` and adds a GLOBAL
  `UNIQUE (provider, provider_wallet_ref)`. A provider wallet is a provider-side
  resource holding real funds, so exactly one link row anywhere in the platform
  may claim it — two organizations pointing at one wallet would each read the
  other's balance. This mirrors 0055's global withdrawal-reference unique:
  provider-side identifiers are not tenant-scoped. 0049 stays as applied
  history; 0056 carries the new reasoning.
- **Program creation is idempotency-key REQUIRED, and the key is derived.**
  Exactly one of body `requestId` (UUIDv4) or the `Idempotency-Key` header —
  both and neither are 400s, the same rule withdrawals already carry. While the
  org-scoped unique existed, a DB constraint caught a retried create; with N
  programs legal nothing downstream can tell a retry from a genuine second
  program, and an unkeyed retry provisions a duplicate wallet the customer may
  then fund. The key is hashed against `(organization, environment, provider)`
  before it reaches the provider, so two organizations pasting the same
  placeholder UUID cannot land on one provider request on the shared account.
  `EarnPortfolioWalletCreateInput.requestId` became a required contract field
  and the Ground client's `?? crypto.randomUUID()` fallback on create was
  deleted — a fallback minted per HTTP attempt guarantees the double-send it
  appears to guard against. The update path's optional key and its fallback are
  unchanged: re-targeting moves no money and is naturally idempotent.
- **A unique violation on create means "already created", answered 200.** The
  provider dedupes on the derived key and replays a retried create with the
  ORIGINAL wallet ref, so a legitimate retry lands on the new global unique by
  design: the handler re-reads by ref and serves the existing program with 200
  (201 is a real create). Answering 409 there would turn the required key into
  the duplicate it exists to prevent. A ref held by a different organization or
  environment is the one genuine conflict — refuse it, never adopt it.
- **Gate ordering is part of the decision, not an implementation detail.**
  `POST /programs` resolves the idempotency key LAST: schema → capability (501)
  → availability (403) → known yield sources (400) → project scope → key (400).
  An unentitled caller sending no key must still learn it is unentitled.
- **Listing has a credential gate that fires on an EMPTY list.** `GET /programs`
  with a `provider` asserts credentials before reading rows. A collection cannot
  404 for emptiness, so without it a missing provider key would be
  indistinguishable from "this organization has no programs" — onboarding shown
  to a customer whose provider is merely unconfigured. The list is ordered
  oldest-first (`created_at ASC, id ASC`) so the head stays stable for a
  program's whole life; a newest-first order would silently re-point any
  consumer that tracks one program across polls.
- **Cross-program BOLA.** `GET /programs/:programId/withdrawals/:ref` now
  compares the ledger row's `wallet_id` to the path program, not the caller's
  organization. An org-only check was complete while an org held one program;
  with several, asking program A for program B's ref would pass and then drive
  the provider with mismatched wallet/withdrawal refs. Unknown refs still fall
  through to the provider's own wallet-scoped read.
- **Unchanged on purpose.** The withdrawal ledger keeps its schema and its
  `(wallet_id, request_id)` unique — wallet scoping was already the right shape
  and now also separates sibling programs' histories. Single-vault (PRO-1667)
  still caps each token group at one allocation entry; this addendum is about
  how many programs an org may hold, not what one program may contain.
- **Path rename.** Every `/v1/earn/program*` path named in the addenda above is
  now `/v1/earn/programs` (list, create) or
  `/v1/earn/programs/:programId/...` (get, re-target, deposits, withdrawal
  preview/create/list/detail). The implicit create-or-update `PUT /program` is
  gone: it was keyed on the triple that stops being addressable the moment a
  second program exists.

## Addendum (2026-08-13) — catalogue-only providers, and the cluster a strategy lives on

Earn V1 was designed around one provider shape: a **custodial** partner (Ground)
fronting an omnibus portfolio wallet SDP provisions and moves money through.
Serving the communal vaults — Kamino now, Jupiter Lend next — introduces a
second shape that the pluggability constraint has to absorb without a rewrite.

- **A provider may front a catalogue and no money movement, and that is a
  complete integration.** Kamino's K-Vaults are non-custodial: the customer's
  own wallet deposits on-chain, so there is no wallet for SDP to provision, fund
  or pay out from. It implements the base `EarnVaultProvider` contract and none
  of the portfolio-wallet capability, and every program route answers 501 for it
  through `supportsPortfolioWallets` — the capability seam doing exactly the job
  it was built for. This is NOT a partial integration to be finished later;
  per-vault execution is a different money model (PRO-1634 territory).
- **A provider may need no credential at all.** Kamino's data API is public.
  `keyPairCredentialDefinition` assumed `<PREFIX>_API_KEY`/`_SANDBOX_API_KEY`
  for every earn provider, in its parameter type and in a drift test that
  expanded `EARN_PROVIDERS` by naming convention. Both now derive from what the
  availability definitions actually READ (`credentialEnvKeys`), with
  `publicApiDefinition` for the keyless case. Declaring a placeholder
  `KAMINO_API_KEY` was rejected: `scripts/secret-keys.mjs` is "every env key the
  SDP API reads", and a declared secret nothing reads is a standing question for
  whoever next provisions the service. The drift test gained an inverse guard so
  a credentialed provider cannot slip through by declaring nothing.
- **The environment no longer implies the cluster; `hostCluster` states it.**
  (The Kamino premise below was later found to be WRONG — it does have a devnet
  deployment; see the 2026-08-14 addendum. The mechanism this bullet introduces
  is unchanged and still load-bearing for any genuinely single-cluster provider.)
  Kamino was believed to be mainnet-only and was catalogued into BOTH
  environments, so a sandbox row honestly named a live mainnet vault and mint.
  `status` could not carry this — it is the operator's stop switch, and reusing
  it would both misstate the reason and collide with the sync's refusal to
  overwrite an operator pause. So every `ProviderStrategySnapshot` states the
  cluster its instrument lives on (migration 0057), and ONE predicate,
  `isClusterFundableInEnvironment`, decides fundability at all three gates: the
  API's `assertKnownYieldSources` before any provider mutation, the derived
  `fundable` on the strategies wire shape, and the dashboard's strategy filter.
  **Being catalogued and being fundable are now different questions, and the
  wire says which.**
- **A catalogue is admitted by an explicit, reviewable floor.** Kamino's vault
  registry is permissionless, so its API is a census of everything ever created
  — 170 vaults, ~90 of the stablecoin ones dust or literal test vaults.
  `KAMINO_MIN_TVL_USD` admits 21. The floor is data, not judgement, and
  `earn:inventory:kamino` commits the census (including the largest near-misses)
  so raising or lowering it is reviewed against what it admits and refuses —
  the same argument that produced the Ground inventory.
- **Rates get their own cadence, and the one-source rule survives.** The hourly
  catalogue sync is right for catalogue drift and wrong for APY. Rather than
  overlay live figures onto stored rows at read time — which would blend two
  sources on the one surface the 2026-08-11 addendum says must not — a second
  pass (`EarnLiveMetricsProvider` / `supportsLiveMetrics`, every 5 minutes)
  refreshes figures IN PLACE. It is UPDATE-only and cannot insert, and its input
  type carries figures only, so it can neither admit a vault the catalogue
  refused nor change what a strategy is. Freshness is cadence, not blending.
  A provider whose rates cost one request per vault should not implement it.

## Addendum (2026-08-14) — surfacing: which registered providers SDP actually offers

The switches above (credentials, org entitlement, strategy status, feature flag)
answer *deployment* and *customer* questions. None answers the **product**
question — "is SDP selling this provider right now?" — and the first time it was
asked, the honest options were all bad: delete a working integration, remove its
credentials and let a `PROVIDER_NOT_CONFIGURED` stand in for a business
decision, or pause every one of its strategies individually and hope the next
catalogue sync respects it.

So registration and surfacing are now separate declarations.
`EARN_PROVIDER_SURFACING` in `packages/sdp-types/src/provider-access.ts` is an
exhaustive `Record<EarnProviderId, boolean>` beside `EARN_PROVIDERS`: the latter
is "what this deployment can talk to", the former is "what we offer today".

- **One declaration, three consumers, no provider ids anywhere else.**
  `GET /strategies` (list and detail) hides an un-surfaced provider's rows;
  `POST /programs` refuses to open a new position with it
  (`assertEarnProviderSurfaced`); the dashboard derives
  `EARN_PROGRAM_CREATION_ENABLED` and drops every create affordance. Hiding at
  the API rather than in the browser is deliberate — the API is the surface the
  dashboard *and* every partner integration read, and a client-side copy of a
  visibility rule is the second thing that drifts toward permissive.
- **Exhaustive on purpose.** A provider added to `EARN_PROVIDERS` without an
  entry is a compile error, so "we registered a provider and never decided
  whether it was public" cannot happen quietly. The default for a new id is a
  decision, not an omission.
- **It gates the way IN, and only the way in.** Reads, withdrawal previews,
  withdrawals, the ledger, and re-targeting an existing program all ignore
  surfacing entirely. This is the money-out-beats-money-off invariant applied to
  a new switch: an organization holding a position taken while a provider was
  offered keeps every route that reads or exits it, and un-surfacing can never
  trap funds. `POST /programs` is the only route that opens a *new* commitment,
  so it is the only one that refuses.
- **Its 403 is not the entitlement 403.** `assertProviderAvailable` answers an
  organization-scoped question and tells the caller to request manual
  activation. No override lifts surfacing, so it runs first and says "not
  currently offered" — pointing a caller at an activation door that does not
  exist is worse than a plain refusal.
- **The catalogue sync and metrics refresh keep running.** `earn_strategies`
  stays a truthful provider inventory, and re-surfacing takes effect on deploy
  rather than after the next hourly pass. Same reasoning as the API's
  `HIDDEN_STRATEGY_TERMS`: filter at the policy boundary, never by refusing to
  store what a provider reports.

**First application: Ground un-surfaced, Kamino the only offered provider.**
Ground is the only portfolio-capable provider, so with it un-surfaced nothing
can create a program and Earn is browse-only — a Kamino comparison catalogue
plus whatever programs already exist. That is a product consequence of the
switch, not a property of it; re-surfacing Ground is a one-line change.

Two consequences worth naming, because both are load-bearing and neither is
obvious:

- **`assertKnownYieldSources` deliberately does NOT inherit the hide.** It
  validates re-target allocations against the STORED catalogue, so a position
  may keep pointing at a row the browse surface no longer shows. Collapsing the
  two would freeze an existing customer's allocation because of an editorial
  decision about new customers.
- **The create test suite is config-independent.** `earn-program.test.ts`
  partial-mocks `isEarnProviderSurfaced` to force it on, because idempotency,
  replay, gate order and environment isolation have to keep working for whichever
  provider is offered next — the gate itself gets its own tests that flip the
  mock off and run against the real map.

## Addendum (2026-08-14) — Kamino has a devnet deployment; each environment catalogues its own cluster

The 2026-08-13 addendum recorded "Kamino is deployed on mainnet only" as a
measured fact and built on it: sandbox was served the mainnet shelf, stamped
`hostCluster: "mainnet-beta"`, permanently `fundable: false`. **The premise was
wrong**, and the cost was a sandbox catalogue an integrator could look at and
never act on.

Measured 2026-08-14, on-chain:

- Kamino runs a **separate devnet kvault program**,
  `devkRngFnfp4gBc5a3LsadgbQKdPo8MSZ4prFiNSVmY` — not mainnet's `KvauGM…`, which
  is *also* deployed to devnet but owns **zero** accounts there. Pointing at the
  wrong one returns a confident empty shelf rather than an error.
- **21 K-Vaults exist on devnet**, all with shares issued. Nine are denominated
  in the official devnet USDC mint (`4zMMC…`, what the Circle faucet dispenses),
  and several deliberately mirror mainnet names — Allez USDC, Steakhouse USDC,
  RockawayX RWA USDC, Gauntlet Frontier USDC.

### Why the original measurement missed it

`api.kamino.finance` indexes mainnet only, and says so nowhere. `?env=devnet`
and `?cluster=devnet` both return **200 with a byte-identical mainnet payload**
(confirmed by hashing the responses), there is no devnet API host, and
`/kvaults/vaults/{devnet pubkey}/metrics` answers 404. A parameter that is
accepted and silently ignored is indistinguishable from a parameter that works.

**The generalisable lesson, now in the playbook:** a hosted API is not evidence
about cluster deployment. Check the chain for a per-cluster program id.

### What changed

- **Two clusters, two data SOURCES, not one source with a parameter.**
  Production reads the mainnet REST shelf; every other environment reads devnet
  vaults on-chain (`getProgramAccounts`, `VaultState` decoded positionally —
  `@sdp/earn` still carries no dependency but `@sdp/types`). Non-production
  issues no request to `api.kamino.finance` at all, which is stronger than
  fetching and filtering.
- **The catalogue sync refuses to STORE a mainnet instrument outside
  production.** Provider-neutral, at the single writer of `earn_strategies`. It
  does not trust a client to get this right, and it is independent of the
  delist pass — which would otherwise leave stale mainnet rows behind whenever a
  devnet read failed. *(Superseded 2026-08-26, PRO-1742 addendum below: mainnet
  rows now DO enter non-production, but only through the sync's browse-only
  mirror lane; the refusal survives as the own-lane foreign-cluster drop.)*
- **No metrics outside production.** The bulk metrics endpoint is mainnet's, so
  `listStrategyMetrics` returns `[]` elsewhere and sandbox rows render no rate.
  A devnet APY would mean blending devnet Klend reserve rates — SDK-sized work
  for a number that is ≈0 because those reserves have no real borrowers. `—` is
  the honest answer.

### What did NOT change, deliberately

`hostCluster`, `fundable`, and `isClusterFundableInEnvironment` all stay. They
stop *firing* for Kamino — its rows now match their environment's cluster in
both — but they still guard Ground, production Kamino, rows already stored under
the old behaviour, and the next genuinely single-cluster provider. The
simplification here is to the mental model ("catalogued but not fundable" was a
Kamino-shaped special case), not to the safety machinery.

## Addendum (2026-08-19) — one provider-neutral movement ledger (PRO-1705)

Earn ended up with **two authoritative movement tables split by execution
mechanism**, not by business meaning:

- `earn_program_withdrawals` (0055) — provider-API portfolio withdrawals.
- `earn_vault_movements` (0059) — signed, on-chain vault deposits.

Both record the same fact — money moved through Earn — so idempotency,
lifecycle, reconciliation, history and reporting existed twice, in two shapes,
and no single query could answer "what moved on this organization". Each new
provider or direction deepened the split.

**Decision: one `earn_movements` ledger, and one `earn_positions` holdings table
behind it.** One row per real-world money movement, both directions, both
execution models, discriminated by an `execution_model` column rather than by
which table it lives in. Migrations 0062-0065.

### What this supersedes

Two earlier plans of record, both explicitly:

- **This addendum's own 2026-08-11 note** that 0048's `earn_movements` was
  "dropped rather than retrofitted", with a movements ledger deferred to the
  execution era. The execution era arrived (0059), and it arrived as a *second*
  ledger. The name is reclaimed; the 0048 SHAPE is not — that table was
  position-scoped with base-unit amounts, a nullable provider, no environment, no
  fingerprint, and a foreign key into the delist-pruned catalogue.
- **Migration 0061's header**, which anticipated the vault withdraw direction
  landing as more columns on `earn_vault_movements`. It lands in the unified
  ledger instead, where `withdrawal` is already a seeded direction.

### What did NOT change

The ledger-vs-live rule from 2026-08-11 stands unaltered: **SDP ledgers what it
initiates; SDP reads live what the provider observes; positions stay live.**
`earn_positions` is a claim index, never a balance — balances and share counts
are still read live on every request, and for a non-custodial vault the chain is
the provider. Customer-initiated custodial deposits remain unledgered because SDP
has no intent moment for them; when an observed-deposit feed is built, it writes
rows into this ledger rather than a third table.

Exit safety is unchanged and extended to the new read: `GET /v1/earn/movements`
takes **no provider gate**, like the reads it generalises. It reports on money
that has already moved, so un-offering a provider, removing its credentials, or
un-entitling an organization closes the door IN and must never remove the record
of what already went through it.

### The parts that carry judgement

- **Amounts carry an explicit `denomination`; shares live only in share-named
  columns.** The concrete accounting hazard a merge could have introduced is USD,
  mint units and vault share counts sharing a column. `denomination` is `usd` for
  a custodial movement and the token MINT for a vault one, and no read may sum
  across rows without grouping by it.
- **Both idempotency anchors survive**, as partial unique indexes over their own
  model's rows: custodial is holding-scoped (a custodial holding is 1:1 with its
  program wallet, so this is 0055's wallet scope in the new shape), vault is
  org-scoped per 0059. Flattening to one anchor would break whichever side lost.
  No fingerprint builder or request-id derivation changed: those values are
  persisted in `wallet_operations.raw_payload.executionRequest`, so altering one
  would 409 every in-flight approved retry across a deploy.
- **`provider_reference` means one thing again.** On 0059's positions it meant the
  INSTRUMENT; on 0059's movements the same name meant the provider's id for the
  movement. The unified ledger keeps the second meaning and names the first
  `vault_address`. This overload is why the two tables could not simply be merged.
- **Closed, earn-owned vocabularies are lookup tables with foreign keys**, not
  `CHECK (x IN (...))` lists. The composite `(execution_model, status)` key makes
  a custodial status unrepresentable on a vault movement. `provider` stays an open
  registry string (ADR 0001) — a new provider must never require a migration.
- **`finalized` is a real state, and `confirmed` is not terminal.** Optimistic
  chain commitment can be dropped in a fork rollback, so settlement means
  finalization for a vault movement and provider completion for a custodial one —
  one meaning of settled across SDP, matching payments (PRO-1716).
- **The transition matrix must agree with the SCHEMA, not merely with itself.**
  `EARN_MOVEMENT_TRANSITIONS` declares no `confirmed → failed` for a vault
  movement, because 0062 ties `confirmed_at`/`shares_out` to the commitment
  states and recording that transition could only succeed by erasing an
  observation SDP genuinely made — and would make "failed before landing"
  indistinguishable from "landed, then dropped in a fork". A confirmed
  transaction dropped by a fork stays in the reconciliation queue as an open
  question rather than being declared failed on a guess.
- **Project attribution is not a lifetime.** `project_id` is nullable with
  `ON DELETE SET NULL` on the unified tables and, from 0062, on
  `earn_provider_wallets` and `earn_program_withdrawals` too. 0055's CASCADE
  meant deleting a project DESTROYED the withdrawal history of money that had
  actually left the organization. Keeping the two shapes isomorphic through the
  expand window also closes a trap: a divergence let a reused idempotency key
  insert a fresh legacy row, collide with the surviving unified row on the
  custodial anchor, and fail that key permanently — because the route
  re-resolves the replay from the legacy table.
- **A missing holding must never fail a money write.** Every movement belongs to
  exactly one holding, so every write path projects the holding BEFORE the
  movement, and the custodial projection opens one if the ledger has none.
  Failing instead would take a program's whole withdrawal endpoint down, and on
  the observation path — where the mirror shares its transaction with the legacy
  write — it would roll back the `provider_reference` stamp for a payout the
  provider had already made. A movement with no reference is the one row no later
  observation can find again. The repair is ENSURE-shaped, not re-project: a
  transition that changes no holding state must not take a row lock on the
  holding, or two concurrent flows against the same one deadlock.

### Migration posture

Expand → backfill → switch → contract, with every intermediate deploy
rollback-safe. The legacy tables keep their writers while their writes are
mirrored into the unified shape in the same transaction; reads switch in a later
release; the legacy tables are dropped last, alone. Each projection is defined
ONCE as a SQL view shared by the bulk backfill and the runtime mirror, because a
projection spelled twice would drift, and history disagreeing with new rows is
the worst outcome this migration could produce.

One asymmetry in that posture is worth stating, because its absence reads as a
guarantee it is not: **0064 establishes history, it does not converge advances.**
`ON CONFLICT DO NOTHING` cannot refresh a row a legacy-only writer ADVANCED
during a rollout or rollback window, and nothing else reaches such a row — the
custodial appliers early-return on a terminal status and the vault reconciliation
queue selects only the unsettled states. 0065 is therefore the same projection
re-stated as a guarded upsert, and it is where the convergence guarantee actually
lives. Before the contract phase stops dual-writing, a read-only parity check
(row counts plus a per-row projection diff) runs in the deployed environments,
expecting zero differences.

## Addendum — 2026-08-20 The vault exit route (PRO-1702)

The vault-direct model's money-out half ships: `POST /v1/earn/vault-withdrawals`
plus the treasury exit action, with Kamino the first `EarnVaultWithdrawProvider`
implementor. The builder preserves Kamino's complete instruction sequence and
the vault lookup table. The API appends the idempotency memo, compiles and signs
one final transaction, then rejects it if its bytes exceed Solana's packet
limit. Solana documents that serialized transaction limit as 1,232 bytes in
[Transaction Structure](https://solana.com/docs/core/transactions/transaction-structure).
The current route fails closed if a future vault layout still exceeds the limit
after lookup-table compression. Supporting that case would require a new,
explicit multi-transaction design for ordered persistence, submission and
reconciliation. This implementation intentionally carries no dormant batching
code or child-record schema for that hypothetical path.

- **One exit is one signed movement.** The `earn_movements` row owns the share
  amount, signature, signed bytes and blockhash window. It is recorded before
  broadcast and reconciled through the same path as a vault deposit. There is
  no child table, ordering state or parent aggregation.
- **A vault WITHDRAWAL row is denominated in the SHARE MINT**, and
  `amount_requested` is the exact share quantity the transaction encodes
  (`sharesAmount: u64`, decoded, never estimated). This refines the 2026-08-19
  "vault movements are denominated in the token mint" line, which was written
  when every vault movement was a deposit: a deposit's exact intent-time fact
  is a token amount, a withdrawal's is a share count, and the tokens a
  withdrawal returns are decided by the chain at execution. Writing a
  build-time token estimate into a money column would launder an estimate into
  "what moved" the moment settlement copies it. The deeper invariant —
  `denomination` is an open set and no read may sum amounts without grouping
  by it — is exactly what makes the asymmetry safe.
- **Exit safety, applied in its strongest form.** The route consults NO
  surfacing, NO entitlement, NO availability, NO catalogue (the caller names
  its own POSITION row, so a delisted vault stays exitable), and NOT the
  `VAULT_DIRECT_DEPOSIT_ENVIRONMENTS` fail-close — an exit works in production
  today, where deposits stay closed pending PRO-1703. The only provider-shaped
  refusal is capability (501, `supportsVaultWithdraw` false), which describes
  SDP's plumbing and never permission. Wallet policy still runs: it is the
  organization's own custody control, not a provider gate.
- **The withdrawal wire speaks the ledger's own vocabulary** (`requested …
  finalized`) and exposes the movement signature directly. This surface
  postdates the unification, so there is no legacy client to translate for.

## Addendum — 2026-08-21 Kora sponsors vault movements, rent included (PRO-1736)

Sponsorship stops being a literal. `resolveVaultSponsorship`
(`services/earn/vault-sponsorship.ts`) answers "who pays" once per request and
the resolved value drives all three places that have to agree, which is the
whole design:

1. the compile-time transaction fee payer,
2. the `rentPayer` handed to the provider's builder, which lands **inside** the
   instruction accounts and funds the share ATA a first deposit creates,
3. the fee payer used to **simulate**.

Passing one value to all three makes the actual bug unrepresentable. Fees were
already sponsorable, but `rentPayer` defaulted to the owner, so a wallet holding
zero SOL still could not make a first deposit. And (3) is not bookkeeping:
simulation enforces that the fee payer can pay, so a zero-SOL wallet simulated as
its own fee payer is rejected with `AccountNotFound` and no logs, before the
signing it would have passed. Verified on devnet against agave 4.2.1.

**Kora pays the ATA rent.** This reverses a prohibition that was written down in
three places (`@sdp/kamino` CLAUDE.md and `types.ts`, this route family's
CLAUDE.md), so the reasoning that changed is recorded rather than quietly
deleted. The objection was that a sponsor would be billed for rent (a) its
`FeePayerPolicy` might refuse and (b) the sponsorship budget did not account
for. Both were checked against the pinned Kora build and the deployed configs:

- (a) Kora gates fee-payer-funded ATA creation on exactly one flag,
  `fee_payer_policy.system.allow_create_account`; its
  `validate_ata_create_instructions` returns early when that is true. The
  `spl_token.allow_initialize_account = false` next to it is irrelevant, because
  Kora validates a pre-execution transaction and the token init is a runtime CPI
  it never sees. devnet already sets the flag true, CI-sanctioned via
  `validate-policy.py --allow-spend system.allow_transfer,system.allow_create_account`.
- (b) The budget prices it, because that same flag is one of the authorities that
  makes the per-transaction reservation `networkFee + max_allowed_lamports`
  rather than the fee alone. devnet reserves ~9,905,000 lamports against
  ~2,039,280 of real ATA rent: a ~5x over-reserve, not an accounting hole.

The mechanism is precedent, not invention: `routes/pay.ts` and the transfer-batch
and recurring-payment paths already make the Kora signer both the ATA rent payer
and the fee payer against deployed Kora. Solana deduplicates account keys, so one
address filling both roles occupies **one** signature slot and a single
`signAsFeePayer` satisfies both. One sponsor identity takes both roles or
neither: a sponsor rent payer without a sponsor fee payer would need a second
real signature SDP cannot produce.

### The exit gives the rent back, and had to be taught how

Sponsoring rent surfaced a leak that predates sponsorship. SDP builds its exit
through klend's `withdrawIxs`, whose `WithdrawIxs` shape carries no cleanup
instructions, so **the share ATA was never closed**: its 2,039,280 lamports of
rent-exemption stayed locked in an account holding zero shares, on every position
ever exited, reclaimable by nobody. The custody wallet was already stranding that
before any of this; sponsorship only changes who is out the lamports.

So the exit now closes the account and returns the rent to whoever paid it:

- **The funder is recorded when the account is created**, on
  `earn_positions.share_ata_rent_funder` (migration 0066). It cannot be
  re-derived at exit: nothing on chain records who funded rent, and the fee mode
  may have flipped in between, so refunding "whoever sponsors today" would
  eventually pay a sponsor with the customer's lamports. The stored value is a
  PROJECTION (migration 0067): each movement that actually creates the account,
  in EITHER direction (an exit consolidating auxiliary share accounts can create
  the ATA itself), records the claim on its own ledger row, and the position
  carries the newest claim that has not failed. A loser of the idempotency race
  has no row to contribute, and a movement whose transaction never lands loses
  its claim when reconciliation fails it, so a refund cannot be directed by a
  transaction that did not land. The one exception to reading it: when the
  exit itself creates the account, the party owed the refund is that exit's own
  rent payer, who funded it moments earlier in the same transaction. The recorded
  funder is authoritative only for an account that pre-dates the exit.
- **Creation is observed, not inferred.** `createAtasIdempotent` emits the same
  instruction whether or not the account exists and charges nothing when it does,
  so only a chain read distinguishes them. The builder reports
  `createsShareAccount` on the plan; absent means no rent was charged and nothing
  is recorded.
- **The close condition is exact.** `CloseAccount` fails on a non-zero balance and
  rides the same transaction as the redemptions, so a wrong guess fails the
  customer's exit rather than merely stranding rent. Two equalities, not one: the
  redeemed quantity must equal what the ATA will hold (which the separate
  share-encoding assertion already pins) AND the owner's total holding of the
  share mint across every account. An emptied ATA with auxiliary accounts still
  holding shares is not a full exit, and closing there hands the next entry a
  funder describing a previous instance of the account.

### Accepted costs, stated so they are not rediscovered

- **Rent is a float, not a subsidy, only for positions that fully exit.** A
  partial exit correctly leaves the account open and its rent parked, and a
  position never exited never returns it. Exposure is bounded by open positions
  at ~0.00204 SOL each.
- **A re-entry pays rent again**, because the close is real. Net still far better
  than never recovering, but it is a per-cycle cost for a wallet that moves in and
  out of the same vault.
- **`max_allowed_lamports` caps a sponsored transaction at 4 new ATAs** on devnet
  (9,900,000 / 2,039,280). Real plans create one, or two for a wSOL vault.
- **Sponsorship costs 96 bytes** (one 64-byte signature slot, one 32-byte account
  key; no instruction account index is added, the payer index just points
  elsewhere) against the 1232-byte limit, and providers size plans without knowing
  a sponsor is coming. The guard runs on the owner-signed bytes, BEFORE the
  paymaster is called: the compiled header fixes the signature count, so those
  bytes are already final length, and checking after would spend a budget
  reservation on a plan that can never be sent.
- **No farm rent.** SDP passes `farmState: null, flcFarmState: null`, so klend's
  farm-stake instructions are always empty and no farm user-state account is
  created. (That also means V1 forfeits farm rewards, which is a separate
  question from who pays.)

### Devnet only, and the cluster gate is exit safety

`isEarnVaultSponsorshipEnabled(env, cluster)` takes the cluster rather than
reading one deployment-global boolean, because a global flag would be unsafe
here. One API process serves both clusters, and vault **withdrawals are
deliberately not environment-gated** under the exit-safety rule above. A global
flag would therefore flip mainnet exits to sponsored at the instant devnet
deposits were enabled, against a mainnet Kora whose
`fee_payer_policy.system.allow_create_account` is false and a mainnet budget
policy that is seeded disabled: a 5xx on a customer's money-OUT path, the one
failure this ADR rules out. The policy flag is the durable leg of that argument,
not the allowlist: sdp-infra#64 puts the mainnet Kamino ids in place while
leaving the policy shut.

**To open mainnet**, three things land together and none is a flag flip: the
Kamino ids reach `kora.mainnet.toml`'s `allowed_programs`
([sdp-infra#64](https://github.com/solana-foundation/sdp-infra/pull/64), open as
of this addendum, and it writes both cluster configs at once so the two cannot
drift); `allow_create_account` is opened there, deferred until compensated
pricing ships; and `sbp_mainnet_global.enabled` is turned on. One
trap worth naming: opening the mainnet policy **without** lowering
`max_allowed_lamports` from 10,000,000 would push the reservation to 10,005,000,
past the seeded per-transaction budget, and deny **all** sponsorship, payments
and issuance included. devnet's 9,900,000 exists precisely to leave that
headroom.

### How a future provider inherits this

`EarnVaultDirectProvider.sponsoredPrograms(cluster)` is a required method, so a
client that can build a deposit but cannot say which programs it touches fails
capability detection and returns 501 rather than silently executing unsponsored.
Kamino's implementation returns the set `assertPlanTargetsCluster` already
enforces on its own output, so what is declared to a paymaster cannot drift from
what is emitted. A unit test asserts the local harness allowlist covers every
provider the execution registry can build a client for. The deployed allowlists
need a live `getConfig`, because only the running service knows what it was
deployed with, so that assertion ships here behind
`EARN_KORA_SPONSORSHIP_SMOKE` and goes unconditional once sdp-infra#64 reaches
devnet.

## Addendum (2026-08-26) — sandbox mirrors the mainnet catalogue behind a cluster toggle (PRO-1742)

This reverses one rule of the 2026-08-14 addendum: "the catalogue sync refuses
to STORE a mainnet instrument outside production". Reviewing the curated
mainnet catalogue (what SDP actually offers customers) previously required
doing that review IN production; now the surface that offers a review
affordance, sandbox, can show the real shelf without being able to fund it.

**Two lanes per non-production environment.** The hourly sync writes each
non-production environment twice: the provider's OWN catalogue for that
environment (the fundable shelf, exactly as before), plus a browse-only MIRROR
of the production pass's accepted mainnet shelf. One fetch per data source per
pass; the mirror is a second WRITE, never a second provider read. Reads default
to the environment's own cluster; the mirror is an explicit `?cluster=` opt-in
(the Treasury strategies card's toggle, sandbox-only). Mirrored rows derive
`fundable: false` on every read and every provider mutation refuses them
(`isClusterFundableInEnvironment`), so the honesty the old persistence refusal
protected lives in the read model and the UI. The refusal itself survives as
the own-lane foreign-cluster drop: a provider's non-production source reporting
mainnet instruments is still drift, warned and skipped.

**Each lane delists only the cluster sub-shelf it is the truth for**
(`deleteUnlistedStrategies` gained a `hostCluster` scope), so one lane's keep
set can never tear down the other lane's rows. The mirror lane additionally
converges to EMPTY on a reliable "nothing is listed" answer: a successful
production fetch with no accepted mainnet rows, or a steady-state skip (stub
provider, production credentials absent or revoked). The usual empty-keep-set
refusal stays absolute for fundable own shelves, where a wrong delete costs a
customer a vault mid-deposit; the asymmetry flips for the mirror because its
rows are browse-only and re-mirrored hourly, while refusing would serve
orphaned "production catalogue" rows forever after production stopped vouching
for them. The repository enforces that an authorized-empty delist is
cluster-scoped, never environment-wide.

**Accepted cap: the mirror is faithful only for cluster-distinct references.**
The upsert key stays (provider, provider_reference, environment) with no
cluster, so a reference listed by BOTH of an environment's truth sources
collides; the environment's own (fundable) row wins the write and the mirror
under-reports exactly those references (warned hourly, and the collided
reference stays in the mirror's delist keep set so a failed own-lane write can
never read as a delisting). Kamino's address-keyed references never collide. A
provider keying both catalogues by a shared slug (Ground's `source.id`) would
collide on every shared slug once surfaced. Decision: keep the bare triple.
Extending the key to the cluster would make every bare-triple consumer
(`updateStrategyMetrics` above all) hit both rows; revisit only if a slug-keyed
provider ever needs a faithful mirror.

**Accepted staleness, and one fidelity gap.** Mirrored rows refresh at the
HOURLY catalogue cadence: the mirror upsert carries the snapshot's
`currentApy` and `riskMetadata`, and the five-minute metrics pass deliberately
does not cross environments (it matches the bare triple, so it would need the
collision protection above). And the mirror carries the provider SNAPSHOT, not
production's stored row, so an operator `paused`/`deprecated` on the
production row does not propagate to the sandbox mirror row. Both are
review-surface fidelity gaps, not deposit paths: `fundable: false` holds
throughout.

## Addendum — 2026-08-26 External wallets: caller-signed vault movements (PRO-1722)

The B2B2C money path ships. An *external wallet* is a **non-custodial wallet**
the partner's platform connects — SDP holds no key for it, and its owner is
not an SDP tenant. Every prior vault money path resolved an exact custody
wallet and signed from it. The contract decided here: **SDP builds and returns
an unsigned
transaction for the external wallet to sign, and records the movement when the
signed transaction is submitted back, before SDP broadcasts it.**

### The load-bearing question: who broadcasts

The vault runtime is built around record-before-broadcast, and a caller-signed
flow moves the point at which the signature becomes knowable. The answer that
preserves the invariant is that **SDP stays the broadcaster**: the partner
returns the signed bytes to `POST /v1/earn/external-wallet/deposits` (or
`/withdrawals`), SDP verifies them, records the `earn_movements` row durably —
signature, wire bytes, blockhash window — and only then sends. Every recovery
property carries over unchanged: an ambiguous send leaves a reconcilable
`requested` row, the sweep rebroadcasts the recorded bytes while the blockhash
lives, and an unlanded transaction expires honestly. A partner CAN broadcast the
signed bytes itself — nothing can stop the holder of a signed transaction — but
the contract records the movement only on submit, and a same-signature
rebroadcast by SDP is idempotent, so a partner that broadcasts AND submits still
converges on one correct ledger row.

### Not a third execution model

An external-wallet movement is a `vault_direct` movement: one signed
transaction, recorded before broadcast, chain lifecycle, same reconciler, same
transition matrix, same org-scoped idempotency anchor. The execution model names
HOW money moves on chain, not whose key signed. The signer distinction is a
column pair — exactly one of `custody_wallet_id` and `owner_address` per vault
row (migration 0070) — and every treasury read scopes by custody wallet, so
external-wallet rows are structurally invisible to those surfaces rather than
filtered by convention.

### The two-call shape, and why the build persists

Each direction is BUILD then SUBMIT. The build runs the gates, asks the
provider for the plan, appends a memo carrying the built transaction's id
(the on-chain identity the custody flow gives the idempotency key), simulates
with the owner as fee payer, compiles, and persists the unsigned transaction
(`earn_external_wallet_transactions`). Persisting is what makes the submit
verifiable: the submit proves the returned bytes are a transaction SDP built by
comparing MESSAGE bytes against the stored build, verifies the owner's ed25519
signature over them, and takes nothing but signatures from the wire. Client
bytes are never trusted for any movement fact.

Idempotency is two composed protections. The submit's required
`Idempotency-Key` anchors the movement (org-scoped, the 0059 rule), so a
partner retry resolves the original movement; and each BUILD is consumable at
most once (`movement_id`, guarded under a row lock), so a second key against
the same build answers 409 instead of ledgering one on-chain transaction twice.
The fingerprint includes the build id: a key retried against a REBUILT
transaction is a different request and conflicts rather than silently replaying.

### Gates, and the asymmetry again

- **Deposit build**: the full money-in stack, unchanged in order and meaning —
  environment capability (`isVaultDirectDepositEnabled`; production stays
  closed by the same constant as the treasury deposit), the production
  `minSharesOut` floor, surfacing, entitlement, catalogue admission.
- **Withdrawal build**: exit safety in its strongest form. 404-scoping
  (organization, environment, EXACT project, owner shape) and capability (501)
  only. The exit works while the provider is disabled for new deposits.
- **The gate moment is the build.** A signed transaction lives only inside its
  blockhash window (~1 minute), so submit-time re-checks buy almost nothing —
  and a partner already holding signed bytes could broadcast them anyway. What
  SDP controls is what it will BUILD and what it records.
- **No wallet policy, deliberately.** Wallet policy governs the organization's
  custody and stands between a request and `createOrgSigner`; this path never
  resolves a signer and moves the OWNER's money on the owner's own
  signature, which IS the authorization. There is no signing sink for the
  value-moving conformance inventory to find.

### Scoping: the external wallet belongs to the partner org AND project

The claim key for an external-wallet position is (org, **project**, environment,
provider, vault, owner) — stricter than the custody claim, where the project is
attribution only. A partner's sibling project is a different integration
surface: it must not learn the position exists, let alone exit it. Movements
carry the exact-claim FK onto (vault, owner) the way custody movements do onto
(vault, wallet).

### Accepted costs, stated so they are not rediscovered

- **Owner pays everything** — fee and rent — until sponsorship lands. Kora
  sponsorship for caller-signed movements is PRO-1744 (p0, follows separately;
  co-signing a stranger's transaction is its own decision). The share-ATA rent
  funder is recorded as NULL (the signing wallet paid and keeps it), so the
  exit's rent refund defaults back to the owner with no attribution to carry.
- **Live hydration of an external-wallet position reads the OWNER's balance in
  that vault**, which includes shares acquired outside SDP. That is the honest
  non-custodial answer — the chain cannot attribute fungible shares to SDP
  movements — and the per-wallet read surface (PRO-1724) inherits it as a
  documented property, not a bug.
- **A partner that broadcasts itself and never submits leaves the movement
  unledgered.** The contract requires submission through SDP; the memo-bound
  build id makes such a transaction attributable after the fact, but nothing
  writes the row.
- **An unconsumed build is inert garbage** that expires with its blockhash; rows
  accumulate until a cleanup sweep exists. Nothing reads them but their own
  submit.

## Addendum — 2026-08-31 External wallets: per-owner reads and the earned figure (PRO-1772)

PRO-1722 shipped the B2B2C surface write-only; this addendum adds the reads
that close the loop: a per-owner activity list and movement detail, and a
balance-plus-earned read. All three take `earn:read` only (no `wallets:read` —
an end-user wallet carries no custody binding) and no provider gate (they
report on money that already moved). Scope is the 0070 claim key — org, EXACT
project, environment, owner — collapsed to one 404 for anything outside it.
`GET /v1/earn/movements` deliberately stays custody-scoped: its vault arm
requires a custody-wallet match an owner-signed row can never satisfy, so the
per-owner reads are a separate surface rather than a widened union. Index:
`idx_earn_movements_external_wallet_owner` (migration 0073).

### The earned figure is stated only when it is exact

`earned` = live current value − Σ finalized SDP deposits, per deposit token.
Three conditions make it unstatable, each answered by an absent field plus a
named `earnedUnavailableReason`, never a zero:

- `live_value_unavailable` — hydration failed; a failed RPC read cannot
  support a claim about someone's money (the 0-vs-unavailable rule again).
- `movements_pending` — a movement is still settling, so the chain and the
  ledger describe different moments; stating a figure in that window would
  swing it by the full amount of the in-flight movement in either direction.
  The reconciler bounds the window (~90 s), so this is a moment, not a state.
- `withdrawals_not_valued` — the ledger records vault exits in SHARES
  (`denomination` = share mint; 0070 pins `payout_token` NULL for vault rows),
  and no share-price history exists to value them in the deposit token.
  Valuing withdrawn shares at the CURRENT price was considered and rejected:
  it counts growth that happened after the user exited, so the error is
  always flattering — the one direction a financial figure must never lean.
  Closing this properly means observing the actual token payout from the
  LANDED transaction at settlement (the same settle-time-observation shape as
  the rent-funder residual above) and is deliberately follow-up work, not
  part of this change.

Scope: every figure covers the wallet's **currently held positions**. A fully
exited position drops out entirely — its deposits leave `totalDeposited`
along with its unvalued withdrawal, so the token stays internally consistent —
because consuming closed positions' history would answer
`withdrawals_not_valued` forever after any full exit, permanently withholding
an earned figure that is exact for what the wallet still holds. The exited
history remains fully visible on the movements list, and the
`withdrawals_not_valued` reason therefore describes a withdrawal on a HELD
position (a partial exit, or a closed-and-re-entered vault, whose claim row is
reused).

The token-level figure is Σlive − Σdeposited (identical to the per-position
sum) and is withheld when ANY contributing position cannot state it — the
never-partial rule the position summary already follows. The live-hydration
caveat stands unchanged: live value reads the owner's whole vault balance, so
shares acquired outside SDP inflate `earned`; that stays a documented property
of non-custodial reads.

## Addendum — 2026-09-02 The partner pays: caller-provided fee payers on the external-wallet builds

Supersedes the "Owner pays everything" accepted cost in the 2026-08-26
addendum. Both external-wallet BUILD routes now take an optional `feePayer`: a
wallet the API caller (the partner) controls, which becomes the transaction's
fee payer and, through the provider's `rentPayer`, funds the share-ATA rent an
account creation needs. The compiled transaction then requires the partner's
signature alongside the owner's; the partner co-signs OUTSIDE SDP before the
submit. This is deliberately not PRO-1744 (Kora, SDP paying): no paymaster, no
budget, no SDP co-signature. The partner funds and signs with its own wallet,
which is why no new policy gate exists — the same authorization-by-signature
rule the surface was built on, now with two signatures.

Decisions that hold it together:

- **Committed at build, unforgeable at submit.** The fee payer lives inside
  the message bytes, so the existing message-equality check makes a swapped
  fee payer a refused submit. It is persisted on the build row
  (migration 0079) so the submit can name the right slot in its errors.
- **One identity, three places** (the PRO-1736 rule restated for a caller's
  wallet): the same resolved value drives the compiled fee-payer seat, the
  simulation fee payer (the funds check moves to the partner wallet, which is
  the point — the zero-SOL owner this feature serves must not fail it), and
  the provider's `rentPayer`. `VaultFeeMode` gained a `caller-provided` kind;
  its consumers are exhaustive, and the custody signing path asserts the new
  kind unreachable.
- **The signer set is asserted ordered and exact** at compile:
  `[feePayer, owner]`, or `[owner]` without one. This keeps refusing a
  provider plan that smuggles an extra signer AND refuses a fee-payer build
  whose plan never names the owner as a signer — with the owner out of the
  fee-payer seat, instruction-level signer roles are the only thing making
  the owner's authorization mandatory.
- **Rent attribution follows the money.** `share_ata_rent_funder` records the
  partner when its wallet funded the account (build row → movement → position
  projection), so the exit refunds the PARTNER; owner-paid rent stays the
  NULL convention. Veda honors `rentPayer` via its ATA payer swap
  (2026-09-02, #1611), so this is provider-neutral.
- **Submit verifies EVERY signature** (ed25519, per-slot error naming), not
  just the owner's: a garbage partner signature is a debuggable 400, never a
  durable movement that can only die at broadcast. The recorded ledger
  `signature` is slot zero — the partner's when present — which is the
  on-chain txid, so reconciliation is unchanged.
- **The split-swap contract carries `feePayer`** through `followUp`, and the
  standalone swap compiles with the same payer, so every transaction the flow
  hands out is partner-payable.

Accepted costs: the partner wallet needs a SOL float and its balance is now
partner-operational surface (a broke sponsor 400s at build, naming the fee
payer); the fee payer adds 96 bytes to the compiled transaction, so near-limit
swap-funded builds fall to the split flow slightly more often; and the
blockhash window now has to fit the partner's co-signature too, which is why
the docs tell partners to co-sign programmatically.
