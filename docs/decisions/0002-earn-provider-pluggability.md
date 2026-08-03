# 0002. Earn provider & curator pluggability

Date: 2026-07-20
Status: Proposed (scaffold branch `earn-initial`)

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
  `configured: false` — hidden from availability and blocked at quote time
  with a clean 503. Removing a key disables the provider for that deployment;
  no code change.
- **Org-level entitlement:** earn providers are override-only — the general
  defaults enable none (`createBooleanRecord(EARN_PROVIDERS, [])`), so every
  organization requires an explicit `providerOverrides.earn.<id>` (manual
  activation), unlike ramps which are on by default.
- **Strategy status:** `active | paused | deprecated` gates individual
  strategies without touching the provider. Catalogue sync re-asserts
  `active` for references the provider still lists, so the durable removal
  path is provider delisting — see the playbook's vault checklist.
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
- **Reads never gate on availability.** Positions, movements, NAV history and
  the catalogue remain readable regardless of provider state, so dashboards
  and partner integrations keep working while a provider is off.

## Consequences

- New provider ≈ one contained PR; the type system is the checklist.
- New curator/strategy source ≈ data + optional label, shippable same day.
- Disabling a provider stops new deposits immediately, leaves withdrawals and
  reads untouched, and requires no deploy.
- Deviation to note: the strategy catalogue is platform-global (carries an
  `environment` column) rather than org/project-scoped — see the header of
  migration `0034_earn.sql`.

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

Operational checklists (provider / vault / category / custodian) live in the
[Earn pluggability playbook](../contributing/earn-pluggability-playbook.md).
