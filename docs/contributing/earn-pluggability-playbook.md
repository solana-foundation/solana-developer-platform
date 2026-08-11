# Earn pluggability playbook

Operational checklists for changing what Earn offers. [ADR 0002](../decisions/0002-earn-provider-pluggability.md)
records *why* each change type has the weight it has; the
[data-flow map](../architecture/earn-v1-data-flow.md) shows where the data
moves. This page is the *how*: exact files, in order, cheapest change first.
The ramp analog for tone and rules is
`.claude/skills/register-provider/SKILL.md`.

| Change | Weight | Where |
|---|---|---|
| Curator | Data only | `risk_metadata.curator` (+ optional display label) |
| Category value | One registry constant | `packages/sdp-types/src/earn.ts` |
| Vault (strategy) | Catalogue row / status flip | Catalogue sync, or SQL for status |
| Vault-infra provider | Compiler-guided code change | Add the id, follow the type errors |
| Custodian | Custody family, not Earn | Signing seam documented below |

## 1. Add or update a curator — zero code

Curators (Gauntlet, Steakhouse, Sentora, ...) are catalogue data, not
integrations. `risk_metadata.curator` is an open string written during
catalogue sync; unknown ids render as-is.

1. Nothing required. The curator id appears once a provider's strategy
   snapshot carries it in `riskMetadata`.
2. Optional: map the id to a display label in `EARN_KNOWN_CURATOR_LABELS`
   (`packages/sdp-types/src/earn.ts`). `earnCuratorLabel` falls back to the
   raw id, so this is cosmetic only.

No migration, no deploy ordering. "Removing" a curator is the provider no
longer reporting it.

## 2. Add a category value — one registry, zero migration

`source_kind`, `apy_type`, and `liquidity_term` are open TEXT in Postgres
with no CHECK constraint, and deposit mints ride in a JSONB array (see the
header of migration `apps/sdp-api/src/db/migrations/postgres/0048_earn.sql`);
the closed unions live in code, per the ADR 0001 asset-profiles pattern.

1. Add the value to the matching const array in
   `packages/sdp-types/src/earn.ts`: `EARN_STRATEGY_SOURCE_KINDS`,
   `EARN_APY_TYPES`, `EARN_LIQUIDITY_TERMS`, or
   `EARN_DEPOSIT_TOKEN_SYMBOLS`. (`EARN_KNOWN_UNDERLYING_SOURCES` is
   deliberately non-exhaustive — new yield sources need no entry at all,
   an entry only labels a known one.)
2. That's the whole DB story — no migration, no CHECK constraint to alter.
3. Filters follow automatically: `apps/sdp-api/src/routes/earn/schemas.ts`
   builds its query validation as `z.enum(EARN_STRATEGY_SOURCE_KINDS)` (etc.),
   so `GET /v1/earn/strategies?sourceKind=...` accepts the new value on the
   next deploy with no schema edit.
4. If the value widens what a provider may front (a new `sourceKind`, a new
   deposit token), extend that provider's `declaredSupport` in
   `packages/sdp-earn/src/providers/<id>/client.ts` — catalogue sync validates
   snapshots against it (`isStrategyWithinDeclaredSupport`,
   `packages/sdp-earn/src/support.ts`) and skips anything outside the
   envelope.
5. A new deposit-token symbol must also exist in the well-known token
   catalogue (`WELL_KNOWN_TOKEN_BY_MINT` in `@sdp/types`): the symbol→mint
   bridge fails closed, so a mint the catalogue doesn't know counts as
   unsupported.

## 3. Add, update, or remove a vault (strategy)

Strategies are catalogue rows in `earn_strategies`, keyed on
`(provider, provider_reference, environment)` and owned by catalogue sync —
not by hand-maintained inserts.

**Add.** Nothing manual on the happy path: the catalogue-sync cron
(`apps/sdp-api/src/cron/earn-catalogue-sync.ts`, hourly, registered in
`cron/runner.ts` behind `isEarnEnabled` — `MARKETS_ENABLED` **and**
`EARN_ENABLED`, both off by default) calls each provider's
`listStrategies` per environment, validates every snapshot against the
provider's `declaredSupport` (fail-closed — out-of-envelope snapshots are
warn-logged and skipped, not persisted), and upserts via `upsertStrategy`
(`apps/sdp-api/src/db/repositories/earn.repository.ts`). A vault the provider
starts reporting appears on the next run; one provider failing (or still
being a `NOT_IMPLEMENTED` stub) never sinks the others' pass.

**Local dev.** Provider credentials aren't needed to get a catalogue:

```bash
pnpm -C apps/sdp-api db:seed:earn                            # sandbox catalogue + NAV history
pnpm -C apps/sdp-api db:seed:earn -- --days 30               # longer NAV history
pnpm -C apps/sdp-api db:seed:earn -- --clean                 # remove seeded rows again
```

The seed is **local-development only**: it refuses any non-local
`DATABASE_URL` and only ever writes `sandbox` fixtures (there is no
`--environment production` — passing it exits with an error).

The script (`apps/sdp-api/scripts/seed-earn-demo.ts`) writes through the same
`upsertStrategy`/`insertNavSnapshot` API and declared-support validation the
sync uses, so seeded rows behave exactly like synced ones; it is idempotent
on the `seed-demo-` provider-reference prefix.

**Update.** Sync-owned fields (name, APY, mints, risk metadata, ...) converge
on the next run; manual edits to those columns get overwritten. `status` is the
exception: the upsert refuses to overwrite `paused` or `deprecated`
(`CASE WHEN earn_strategies.status IN ('paused','deprecated') …` in
`earn.repository.postgres.ts`), so an operator stop outranks the provider
catalogue and cannot be undone by a sync pass.

**Remove — flip status, never delete.** `EARN_STRATEGY_STATUSES` is
`active | paused | deprecated`:

- `paused` — reversible stop. Deposit quotes/execution are refused
  (409 `STRATEGY_NOT_AVAILABLE`); withdrawals and all reads keep working
  (the row leaves the default catalogue list, which filters to `active`, but
  stays fetchable by id).
- `deprecated` — terminal wind-down. Same runtime semantics as `paused`;
  the difference is intent (the strategy will not come back).

Flipping the status is immediate **and** durable, even while the provider still
lists the vault: the upsert never resurrects a `paused`/`deprecated` row, so an
emergency stop (exploit, depeg, provider incident) holds until someone
deliberately writes the status back to `active`. Metadata and rates keep
converging in the meantime, so the row stays accurate while closed. Wider
kill switches remain available when a whole provider is suspect: switch the org
entitlement override off, or pull the environment credentials — withdrawals
continue either way.

The asymmetry is the ADR 0002 exit-safety invariant — **money out always
beats money off**: deposits require an *active* strategy plus the full
entitled+configured provider gate, while withdrawals ignore strategy status
and need only provider credentials (`assertEarnProviderConfigured`). Both
halves are enforced in `requireQuotableStrategy`
(`apps/sdp-api/src/routes/earn/handlers/quotes.ts`) and covered by route
tests (`apps/sdp-api/src/routes/earn.test.ts`). Never delete a strategy row:
positions and movements FK into it, and history must survive wind-down.

## 4. Add a vault-infra provider — add the id, follow the compiler

`EarnProviderId` is a closed union, so adding the id breaks the build until
every registration point is filled — the type errors are the checklist, and
two tests guard the registration points the compiler can't see.

**Ground is the worked example** for every step below — its files are the
copyable precedent (`ground` id, `GroundEarnClient`, `GROUND_API_KEY` /
`GROUND_SANDBOX_API_KEY`), and it is the first client past the stub: a live
`listStrategies` plus the portfolio-wallet capability (§4b).

| Step | File | What you add (Ground precedent) |
|---|---|---|
| 1. Declare the id | `packages/sdp-types/src/provider-access.ts` | Append to `EARN_PROVIDERS`. Earn entitlements are override-only (`createBooleanRecord(EARN_PROVIDERS, [])`): every org gets the provider disabled until an explicit `providerOverrides.earn.<id>` — there is no tier-default list to join. |
| 2. Client class | `packages/sdp-earn/src/providers/<id>/client.ts` | Subclass `StubEarnClient` (`packages/sdp-earn/src/providers/stub.ts`) carrying only the `provider` literal and `declaredSupport`. Every operation throws `NOT_IMPLEMENTED` until you override it — the integration lands method-by-method, with `providerFetchJson` (`packages/sdp-earn/src/fetch.ts`) as the HTTP core. |
| 3. Registry | `packages/sdp-earn/src/index.ts` | `<id>: new <Id>EarnClient()` in `EARN_PROVIDER_CLIENTS` + the class re-export. |
| 4. Subpath export | `packages/sdp-earn/package.json` | A `"./providers/<id>/client"` exports entry. |
| 5. Availability | `apps/sdp-api/src/services/provider-availability.service.ts` | One line: `<id>: keyPairCredentialDefinition("<Label>", "<ID>")`. |
| 6. Credential keys | `apps/sdp-api/src/types/env.d.ts` | `<ID>_API_KEY` + `<ID>_SANDBOX_API_KEY`. `keyPairCredentialDefinition` binds its derived keys to `keyof Env`, so skipping this is a compile error. |
| 7. Key projections | `turbo.json` `globalEnv` + `scripts/secret-keys.mjs` | Both keys in both files (+ the secret manager for deployed environments). |
| 8. Managed deployments | sdp-infra `terraform/envs/<env>/terraform.tfvars` | Append the credential key(s) to `app_secret_keys` (the Doppler → Secret Manager mirror; also add the value to that env's Doppler config). Dev carries sandbox keys only — production keys are a launch-gated decision (PRO-1647). Nothing else: the Cloud Run service and Job read the same secret set, and the hourly catalogue sync picks the provider up from `EARN_PROVIDER_CLIENTS` with zero job changes (`src/job.ts` never names providers; an un-credentialed provider skips fail-closed with `PROVIDER_NOT_CONFIGURED`). |

Tests that enforce the checklist (run them; they fail on the exact step you
missed):

- `packages/sdp-earn/src/index.test.ts` — every `EARN_PROVIDERS` id has a
  registry entry with a matching `provider` field and a `package.json`
  subpath export (steps 3–4).
- `apps/sdp-api/src/services/provider-availability.drift.test.ts` — both
  credential keys appear in `turbo.json` `globalEnv` and
  `scripts/secret-keys.mjs` (step 7).

Verify with `pnpm --filter @sdp/earn typecheck && pnpm --filter @sdp/earn test`
plus the API vitest suite. Rules carried over from the ramp skills: no
fallbacks (missing config throws `PROVIDER_NOT_CONFIGURED`; unknown ids fail
closed through `resolveEarnProviderClient`), HTTP in the provider and DB in
the handler, and provider ids are never reused — retirement means deprecating
strategies and draining positions first, then removing the id.

## 4b. Implementing the portfolio-wallet capability

Some providers front a *portfolio* wallet (one wallet, weighted allocations
across yield sources) rather than per-strategy deposits. That surface is an
**optional** extension of the base contract — implement it only when the
provider actually offers it.

1. **Implement the full interface, or none of it.**
   `EarnPortfolioWalletProvider` (`packages/sdp-earn/src/types.ts`) extends
   `EarnVaultProvider` with nine methods: `createPortfolioWallet`,
   `getPortfolioWallet`, `updatePortfolioStrategy`, `getPortfolioYield`,
   `listPortfolioDeposits`, `previewPortfolioWithdrawal`,
   `createPortfolioWithdrawal`, `getPortfolioWithdrawal`,
   `createPortfolioAddressBookEntry`. (`getPortfolioYield` is its own method
   because providers serve yield metrics from a distinct endpoint — callers
   that only need balances must not pay for it — which also makes it the easy
   one to forget.) Callers detect the capability with
   `supportsPortfolioWallets` (`@sdp/earn/capabilities`), which checks that
   whole list (`PORTFOLIO_WALLET_METHODS`) — an all-or-nothing
   method-presence guard, so a partial implementation is treated as
   unsupported.
2. **Speak the shared DTOs.** Wire shapes live in `@sdp/types/earn`
   (`EarnPortfolioWalletSnapshot`, `EarnPortfolioDeposit(sPage)`,
   `EarnPortfolioWithdrawal(Preview)`, statuses, tokens). Map provider
   statuses into the neutral unions (Ground: `idle` → `ready`, any
   `*_active`/unknown → `busy`); all USD amounts are decimal strings in the
   contract — convert to the provider's wire format only at the HTTP
   boundary.
3. **Solana-only surface.** Expose only the wallet's Solana deposit address
   for the environment (devnet rail in sandbox, mainnet in production) and
   pin withdrawal/preview destination chains the same way, even if the
   provider is multi-chain internally.
4. **Idempotency.** A withdrawal requires EXACTLY one caller-supplied key —
   `requestId` (UUIDv4) or the `Idempotency-Key` header — and 400s on both or
   neither, because no precedence rule can tell which one a caller's retry
   holds stable. The key is not forwarded as given: `deriveProviderRequestId`
   hashes it against the program wallet, so two organizations sharing one
   provider account cannot collide on the same pasted value. Create/update is
   looser and may generate a UUIDv4 when omitted. A provider
   requestId-conflict error surfaces as `CONFLICT`.
5. **Persistence.** One shared wallet per org+environment+provider:
   `earn_provider_wallets` (migration `0049_earn_provider_wallets.sql`), via
   `EarnRepository.getProviderWallet` / `insertProviderWallet` — the unique
   constraint makes double-provisioning a first-writer-wins race, not a
   duplicate.
6. **Tests.** No-network fetch-stub harness, same pattern as
   `packages/sdp-earn/src/fetch.test.ts`; Ground's
   `providers/ground/client.test.ts` covers mappings, filtering, pagination,
   error taxonomy, requestId behavior, and the capability guard —
   `capabilities.test.ts` is the guard's own suite.

**Live sandbox runs need a key:** `GROUND_SANDBOX_API_KEY` has to reach the
process before anything can talk to Ground's sandbox. Locally that means
`apps/sdp-api/.env.local` (gitignored): the Doppler wrapper
(`scripts/doppler/run-with-config.sh`) overlays `apps/*/.env.local` on top of
the Doppler-injected values, so the file wins with no `DOPPLER_PRESERVE_ENV`
opt-in — a plain shell export, by contrast, is dropped. Deployed environments
take the key from Doppler/Secret Manager instead — reaching a *managed* runtime
additionally requires the key in sdp-infra's `app_secret_keys` (step 8 of the
§4 checklist), which feeds both the Cloud Run service and the cron Job. Until
it resolves, the provider is `configured: false` and every call fails closed
with `PROVIDER_NOT_CONFIGURED` (tests never hit the network, so they don't
care).

**Reaching Earn at all needs both module flags:** `MARKETS_ENABLED` (parent)
and `EARN_ENABLED` (child) are off by default in *every* environment, local dev
included — there is no development default-on. Without both, `/v1/earn` answers
403 and the dashboard segment `notFound()`s. Set them for `sdp-api` **and**
`sdp-web` (same unprefixed names; see each app's `.env.local.example`).

## 5. Custodian seam — "add Anchorage/Fireblocks to Earn"

Custodians are **not** Earn providers. They live in the custody family:
`CUSTODY_PROVIDERS`, `FULL_SIGNING_CUSTODY_PROVIDERS`, and
`CUSTODY_PROVIDER_CAPABILITIES` in `packages/sdp-types/src/custody.ts`, with
the runtime adapter map in
`apps/sdp-api/src/services/domain/signing/provider-adapter-factory.ts`. Earn
never dispatches to a custodian directly: execution (`POST /deposits`,
`POST /withdrawals` — execution phase) signs provider-built transactions
through the existing custody signing service, so a wallet that can sign for
payments can sign for Earn with zero Earn-side code.

What that means in practice:

- **Fireblocks** (and every other `FULL_SIGNING_CUSTODY_PROVIDERS` member) is
  already Earn-capable: once the execution endpoints land, its wallets sign
  Earn transactions through the same adapter they use today.
- **Anchorage** is currently lifecycle-only: `supportsSigning: false` in
  `CUSTODY_PROVIDER_CAPABILITIES`, absent from
  `FULL_SIGNING_CUSTODY_PROVIDERS`, and mapped to `LifecycleOnlyAdapter` in
  the adapter factory. Giving Anchorage-custodied wallets Earn means giving
  Anchorage signing — a custody-family change (real adapter + both
  registries), after which Earn rides along for free.
- **The one known gap:** `SigningMetadata.operationType` is a closed union at
  `packages/sdp-custody/src/signing.ts:99`
  (`"deploy" | "mint" | "burn" | "freeze" | "thaw" | "transfer"`). It must
  gain Earn operations (e.g. `"earn_deposit" | "earn_withdrawal"`) when
  execution lands, so policy evaluation and audit can discriminate Earn
  signing from transfers instead of mislabeling it.
