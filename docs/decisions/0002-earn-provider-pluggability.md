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
   the client registry (`EARN_PROVIDER_CLIENTS` in `@sdp/earn`), entitlement
   defaults, and the availability definitions
   (`provider-availability.service.ts`). The compiler enumerates every
   registration point, so "a lot of lift" is replaced by "follow the type
   errors". Full checklist:
   - `packages/sdp-types/src/provider-access.ts` — add the id to
     `EARN_PROVIDERS`; fill the entitlement defaults the build now demands.
   - `packages/sdp-earn/src/providers/<id>/client.ts` — implement
     `EarnVaultProvider` (stub methods may throw `notImplemented`).
   - `packages/sdp-earn/src/index.ts` — register in `EARN_PROVIDER_CLIENTS`
     (+ `package.json` exports entry for the new subpath).
   - `apps/sdp-api/src/services/provider-availability.service.ts` — add the
     `earn.<id>` availability definition (sandbox/production key pair).
   - `apps/sdp-api/src/types/env.d.ts`, `turbo.json` `globalEnv`,
     `scripts/secret-keys.mjs` — declare the credential keys (+ Doppler).

### Enable/disable without breakage

Independent switches, all runtime-safe:

- **Environment kill switch:** a provider with no credentials configured is
  `configured: false` — hidden from availability and blocked at quote time
  with a clean 503. Removing a key disables the provider for that deployment;
  no code change.
- **Org-level entitlement:** tier defaults + `providerOverrides.earn` allow
  per-organization enable/disable, same as ramps.
- **Strategy status:** `active | paused | deprecated` gates individual
  strategies without touching the provider.
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
