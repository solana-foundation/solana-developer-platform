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
  remain readable regardless of provider entitlement, and the movement
  ledger list carries no provider gate at all (2026-08-11 and 2026-08-12
  addenda), so dashboards and partner integrations keep working while a provider
  is off. Missing credentials stop new observations, never reads.

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
- **Deposits stay live.** *(Superseded — see the 2026-08-12 movement-ledger
  addendum: deposits are now ledgered at observation. What this bullet got right
  is that SDP has no intent moment for a customer-initiated transfer; what it got
  wrong is concluding SDP can therefore hold no record of one. Those are separate
  questions, and the answer to the second is the provider's own deposits API —
  an observation SDP already makes on every dashboard poll and then discards.)* A
  deposit is a customer-initiated transfer SDP never sees at intent time;
  observing it from chain is indexer-shaped work (a stated non-goal). Deposits
  surface through the live program snapshot and enter a ledger only when SDP
  initiates them (execution era).
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

## Addendum — 2026-08-12 Every money movement is ledgered; the observer is pluggable (PRO-1669)

The decision above stands. This supersedes the "Deposits stay live" bullet of the
2026-08-11 addendum, which conflated two separate questions: whether SDP
*initiates* a movement, and whether SDP can hold a *record* of one. It cannot
initiate a customer's SPL transfer; it can perfectly well observe it, and the
provider's own deposits API is an observation SDP already makes on every
dashboard poll and then throws away. The governing principle is refined, not
replaced:

> **SDP ledgers every money movement: what it initiates, at intent; what it
> observes, at observation. Positions and balances stay live, permanently.**

- **Three categories, and every money movement sits in exactly one.**
  *Initiated* — the row exists before the provider accepts the call, and
  `requested` is a real state (withdrawals). *Observed* — the row is created by
  the first observation, there is no intent state, and the record's status
  vocabulary is the provider-observed one with nothing added (deposits).
  *Live* — a derived aggregate with no event identity, never a movement
  (positions, balances, yield).
- **One table, two writers, two state machines.** `earn_program_withdrawals`
  becomes `earn_program_movements` with a `direction` discriminator (migration
  `0057`). This restores the shape 0048 chose and 0055 never disputed: 0055
  dropped `earn_movements` for its *grain* — position-scoped, base-unit amounts,
  no writer — not for unifying the directions, and its own header cites
  `payment_transfers`, which is a single table carrying both legs. Deposit
  statuses are a strict subset of withdrawal statuses, so one `status` column
  serves both with no new CHECK value. The two *appliers* stay separate
  (`earn-withdrawal-ledger.service.ts`, `earn-deposit-ledger.service.ts`):
  initiated-with-intent and observed-upsert are genuinely different machines,
  and merging them would put `if (direction === …)` inside transition logic.
- **The intent columns became direction-conditional CHECKs, not casualties.**
  `request_id`, `idempotency_fingerprint`, `destination_address` and
  `project_id` are now nullable at the column level and immediately re-required
  for `direction = 'withdrawal'`. That preserves 0055's stated reason exactly —
  a null fingerprint must be unrepresentable, or `resolveIdempotencyReplay`'s
  "null fingerprint = unclaimed" branch turns the unique-violation replay
  backstop into an unrecoverable 500 — for the only direction that can reach
  that code path, since the replay lookup queries by `request_id` and can only
  ever return a withdrawal. Two invariants 0055 could express only by omission
  are now written down: a deposit may not carry intent columns at all, and
  `requested` is withdrawal-only. In TypeScript the row type is a discriminated
  union, so the withdrawal arm keeps non-null intent fields where the guarantee
  actually lived.
- **The record is observation-source-agnostic; the observer is interchangeable.**
  Rows carry `observed_via` — a *mechanism* (`sdp_intent`, `provider_poll`,
  `provider_webhook`, `chain_indexer`), never a provider — and no transition
  matrix branches on it. Three observers join over the product's life with no
  schema change: provider-API polling now (a cron sweep, plus a best-effort
  write from the live deposits read), provider webhooks next (PRO-1631, Ground
  HMAC, which reuse the same applier through a different adapter), and an SDP
  indexer reading Solana directly eventually. `observed_via` is deliberately
  **not** CHECK-constrained: a check would make adding the third observer a
  migration, which is precisely the coupling this decision removes. Per-source
  differences belong in the adapter that *builds* an observation, never in the
  machine that applies it; a source-grep test pins that.
- **The indexer is the desired end state, named as such.** The superseded bullet
  dismissed a deposit ledger because observing customer-initiated transfers from
  chain is indexer-shaped work, a stated non-goal. The non-goal holds — V1 ships
  no indexer, and the catalogue and position surfaces still need none. What was
  wrong was treating the *record* as blocked on it. The interim observer is the
  provider's own API; the end state is an SDP indexer, wanted because it takes a
  third party out of the path of SDP's own audit trail and sees arrivals at chain
  finality rather than at the provider's detection latency. This commits to the
  record now and to the observer being swappable. It does not schedule the
  indexer, and the poller is expected to become a backstop and then to be
  deleted — nothing downstream may assume the poller is the writer.
- **Identity is dual, and only the interim half is armed.** The provider's own
  movement id anchors a global partial unique on
  `(provider, direction, provider_reference)` — global for 0055's reason
  (provider-side identifiers are not tenant-scoped) and direction-qualified
  because only Ground *happens* to prefix its deposit and withdrawal ids; a
  provider with one id space would otherwise collide a deposit against a
  withdrawal. Chain identity is
  `(wallet_id, transaction_signature, transaction_instruction_index)`, a second
  partial unique no V1 observer can fill (the provider feed reports no
  instruction index) which arms itself the day an indexer writes. **A unique on
  `transaction_signature` alone would be a bug, not a simplification:** two SPL
  transfers to one funding address inside one transaction are legal and the
  provider reports them as two deposits sharing a hash, so that index would
  reject the second and silently drop real money — the lesson
  `private_channel_settlement_observations` already records with its
  `(signature, instruction_index)` primary key. The signature column is also
  nullable by necessity: a shared provider wallet is fundable on non-Solana
  rails, and invariant 5 withholds a foreign rail's identifiers while the value
  still surfaces.
- **Cross-source dedupe is a service obligation, not a constraint.** A provider's
  deposit id and an indexer's `(signature, index)` are not mutually computable,
  so no column makes them collide. The applier resolves by provider reference,
  then by signature, and that ordering works in both directions: an indexer
  adopts and advances a row the poller wrote, and a poller stamps
  `provider_reference` onto a row the indexer wrote. Skip rather than guess when
  a signature probe is ambiguous — a double-counted movement breaks
  reconciliation silently.
- **`occurred_at` is when the money moved; `created_at` is when SDP wrote the
  row.** For an initiated movement they are the same instant, which is why the
  migration backfills one from the other. For an observed one they are
  structurally different, and conflating them would make the ledger's sort key
  depend on cron health, put an indexer backfill of January deposits at the top
  of a list, and mis-attribute a period by exactly the observation lag.
  `occurred_at` is write-once and is both the ordering key and the aggregation
  key; the gap between the two is the only honest measure of observation lag.
- **The canonical movement read is `GET /v1/earn/programs/:programId/movements`,
  and it carries no provider gate at all** — the audit trail outlives credential
  removal, entitlement disablement, and a provider losing its registry entry.
  Missing credentials stop new observations, never reads. This is not a
  resurrection of the top-level `/v1/earn/movements` that 0055 pruned: that route
  was position-scoped with base-unit amounts and never had a writer, it stays
  404, and a paired test pins the 404 alongside the new route serving.
  `GET …/withdrawals` is retained, direction-pinned, and soft-deprecated in its
  favour. `GET …/deposits` stays a **live** provider passthrough — the only
  surface that answers "did my transfer land" in seconds — and advances the
  ledger best-effort as a side effect, the shape the withdrawal detail read
  already carries. One attempt, not the create path's retry loop: a missed
  observation is re-offered by the feed on the next poll. Every route still
  reports exactly one source of state.
- **The sweep never gates money and never fails on a missing key.** It resolves
  each wallet's client through the fail-closed registry, checks
  `supportsPortfolioWallets`, and treats `NOT_IMPLEMENTED` and
  `PROVIDER_NOT_CONFIGURED` as steady states — an environment without
  credentials is the normal pre-launch condition, not an incident. Per-wallet and
  per-row failures are logged and swallowed so one bad program cannot sink the
  platform's pass, and work is capped per run rather than drained. It walks each
  feed from the head every pass on purpose: the feed has no `since` filter and an
  opaque cursor of undocumented order, so every cheap termination rule is
  order-dependent and wrong in one direction. It is not a request path and never
  decides whether money may move.
- **Forensics rule restated.** The 2026-08-11 rule — money-movement tables carry
  write-only `project_id`, `created_by`, `initiated_by_key_id` — was written for
  movements SDP initiates. An observed deposit has no SDP-side actor to name, and
  inventing a project or a user writes a fiction a human later reads as fact
  during an incident. Restated: *a money-movement row carries provisioning
  attribution when an SDP actor initiated it, and the observing mechanism when
  none did.* A deposit's attribution is the program wallet it landed in, which is
  the row's scope anyway. Consequence worth knowing: `project_id`'s cascade means
  deleting a project deletes withdrawal history but not deposit history.
- **The ledger records arrival, never deployment.** A deposit reaching
  `completed` means the funds landed as `cash` in the portfolio wallet. The later
  provider-managed rebalance that deploys them is not a movement out of the
  wallet and has no row. Never read a completed deposit as "earning".
- **Unchanged on purpose.** The `earn_positions` / `earn_movements` /
  `earn_nav_snapshots` drops stand, and this addendum adds no position ledger:
  positions and balances remain live-only, permanently. PRO-1634's movements
  question narrows to *initiated* per-strategy execution, which still has no
  consumer.
- **Open, and framed here so the next ticket does not discover it:** balance and
  yield **history** (PRO-1672) cannot be satisfied by a live read, because
  history is the one thing that cannot be backfilled — every day V1 runs without
  capture is reporting data lost forever. With movements ledgered, yield per
  period falls out of Δbalance − net movements, but the balance terms do not
  exist anywhere. That sits against the live-only-permanently rule above, so
  PRO-1672 needs a decision, not code. The only shape that keeps both true: a
  periodic snapshot written for **reconciliation only**, never a serving read,
  with no API route ever answering a balance question from it — the live provider
  snapshot stays the single source for current balance. `earned_usd` inherits
  whichever answer balances get. Deciding it belongs to PRO-1672's own dated
  addendum.
- **Amended above:** the "Reads never gate on availability" invariant now names
  the movement ledger list rather than the withdrawal one, and the "Deposits stay
  live" bullet of the 2026-08-11 addendum is marked superseded in place. Every
  other bullet of that addendum stands — including the withdrawal ledger's
  two-layer idempotency, its heal semantics, and the hard requirement that a
  sweep discriminate definitive provider rejections from transport failures
  before re-driving a ref-less `requested` row.
