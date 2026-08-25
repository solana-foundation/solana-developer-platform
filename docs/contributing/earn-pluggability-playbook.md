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

**Where the id may come from.** A curator attribution is SDP vouching for who
runs a vault, so it must trace to something the PROVIDER establishes: a curator
field, verified authority/address data, or an audited vault-address allowlist.
It may never be parsed out of a label the public can choose. Ground's
`deriveCurator` reads Ground's own yield-source ids, which is why that precedent
is safe and does not generalise: Kamino's registry is permissionless, so its
vault names carry no authority and its snapshots carry no curator at all (see
`packages/sdp-earn/CLAUDE.md`). The same test applies to `sourceKind` — an `rwa`
classification asserts real-world backing, and an integrator filters on it.

## 2. Add a category value — one registry, zero migration

`source_kind`, `apy_type`, and `liquidity_term` are open TEXT in Postgres
with no CHECK constraint, and deposit mints ride in a JSONB array (see the
header of migration `apps/sdp-api/src/db/migrations/postgres/0048_earn.sql`);
the closed unions live in code, per the ADR 0001 asset-profiles pattern.

1. Add the value to the matching const array in
   `packages/sdp-types/src/earn.ts`: `EARN_STRATEGY_SOURCE_KINDS`,
   `EARN_APY_TYPES`, `EARN_LIQUIDITY_TERMS`, or
   `EARN_DEPOSIT_TOKEN_SYMBOLS`. (`underlyingSource` is an open string with
   no registry at all — new yield sources need no entry anywhere.)
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

**Local dev.** Use sandbox provider credentials and enable both
`MARKETS_ENABLED` and `EARN_ENABLED` before starting the API. The hourly
catalogue sync is the only admitting writer, so a fresh database stays empty
until a live provider pass succeeds. Do not insert catalogue rows by hand: that
bypasses the provider's declared-support checks and leaves rows the delist pass
cannot justify.

**Carrying rows from the old `db:seed:earn`?** That script wrote
`seed-demo-`-prefixed strategies and one wallet link, and only ever into a
local database (it refused any non-loopback `DATABASE_URL`). The next sync pass
prunes the *active* fixtures on its own now that the delist exemption is gone,
but two kinds of row outlive it by design: the deliberately `paused` fixture
(the pass never deletes an operator stop) and the wallet link, which holds the
global `UNIQUE (provider, provider_wallet_ref)` claim on the shared sandbox
wallet. Clear both once, against your local database:

```sql
DELETE FROM earn_strategies WHERE provider_reference LIKE 'seed-demo-%';

DELETE FROM earn_positions position
 WHERE position.kind = 'custodial'
   AND position.provider_wallet_id IN (
     SELECT id FROM earn_provider_wallets
      WHERE label = 'Seeded sandbox wallet (local dev)'
   )
   AND NOT EXISTS (
     SELECT 1 FROM earn_movements movement
      WHERE movement.position_id = position.id
   );

DELETE FROM earn_provider_wallets
 WHERE label = 'Seeded sandbox wallet (local dev)'
   AND NOT EXISTS (
     SELECT 1 FROM earn_positions position
      WHERE position.provider_wallet_id = earn_provider_wallets.id
   );
```

`earn_movements` FKs the unified position with no cascade, and `earn_positions`
FKs the link row with no cascade, so any wallet with movement history survives
both guarded deletes (migration `0062`). Recreating the local database from
scratch is the other valid answer.

**Update.** Sync-owned fields (name, APY, mints, risk metadata, ...) converge
on the next run; manual edits to those columns get overwritten. `status` is the
exception: the upsert refuses to overwrite `paused` or `deprecated`
(`CASE WHEN earn_strategies.status IN ('paused','deprecated') …` in
`earn.repository.postgres.ts`), so an operator stop outranks the provider
catalogue and cannot be undone by a sync pass.

**Remove — flip status, never delete.** `EARN_STRATEGY_STATUSES` is
`active | paused | deprecated`:

- `paused` — reversible stop. The strategy cannot be selected as a program
  allocation target (program create and re-target both validate against the
  *active* catalogue); withdrawals and all reads keep working (the row leaves
  the default catalogue list, which filters to `active`, but stays fetchable by
  id).
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
beats money off**: money-in requires an *active* strategy plus the full
entitled+configured provider gate (`POST /programs` and
`PUT /programs/:programId` via `assertProviderAvailable` +
`assertKnownYieldSources`), while withdrawals ignore strategy status and need
only provider credentials
(`assertEarnProviderConfigured`) — and the withdrawal-ledger list needs not
even that. Both halves are covered by route tests
(`apps/sdp-api/src/routes/earn-program.test.ts`). Never delete a strategy
row: catalogue history must survive wind-down, and program allocations
reference strategies by provider reference.

## 4. Add a vault-infra provider — add the id, follow the compiler

`EarnProviderId` is a closed union, so adding the id breaks the build until
every registration point is filled — the type errors are the checklist, and
two tests guard the registration points the compiler can't see.

**Two worked examples**, and which one you copy depends on how the provider
holds the money:

- **Ground — custodial portfolio.** `ground` id, `GroundEarnClient`,
  `GROUND_API_KEY` / `GROUND_SANDBOX_API_KEY`; a live `listStrategies` plus the
  portfolio-wallet capability (§4b). Copy this when SDP provisions a wallet and
  moves funds through the provider.
- **Kamino — catalogue-only, and keyless.** `kamino` id, `KaminoEarnClient`, no
  credential at all; the base contract plus the live-metrics capability (§4c)
  and *none* of the portfolio-wallet surface. Copy this when the provider's
  vaults are non-custodial — the customer's own wallet deposits on-chain, so
  there is nothing for SDP to provision, and `supportsPortfolioWallets`
  returning false is the finished answer rather than a TODO. Every program route
  then answers 501 by capability detection, with no dispatch edits.

Steps 5–8 below are the **credentialed** path. A provider on a public API skips
most of them — see the keyless variant under the table.

| Step | File | What you add (Ground precedent) |
|---|---|---|
| 1. Declare the id | `packages/sdp-types/src/provider-access.ts` | Append to `EARN_PROVIDERS`. Earn entitlements are override-only (`createBooleanRecord(EARN_PROVIDERS, [])`): every org gets the provider disabled until an explicit `providerOverrides.earn.<id>` — there is no tier-default list to join. |
| 1b. Decide if it is OFFERED | `packages/sdp-types/src/provider-access.ts` | Add the id to `EARN_PROVIDER_SURFACING` — it is exhaustive over `EarnProviderId`, so step 1 does not compile without it. `true` = customers see its strategies and may open programs with it; `false` = fully integrated but not offered (§6). Start a work-in-progress integration at `false`. |
| 2. Client class | `packages/sdp-earn/src/providers/<id>/client.ts` | Subclass `StubEarnClient` (`packages/sdp-earn/src/providers/stub.ts`) carrying only the `provider` literal and `declaredSupport`. Every operation throws `NOT_IMPLEMENTED` until you override it — the integration lands method-by-method, with `providerFetchJson` (`packages/sdp-earn/src/fetch.ts`) as the HTTP core. |
| 3. Registry | `packages/sdp-earn/src/index.ts` | `<id>: new <Id>EarnClient()` in `EARN_PROVIDER_CLIENTS` + the class re-export. |
| 4. Subpath export | `packages/sdp-earn/package.json` | A `"./providers/<id>/client"` exports entry. |
| 5. Availability | `apps/sdp-api/src/services/provider-availability.service.ts` | One line: `<id>: keyPairCredentialDefinition("<Label>", "<ID>")`. |
| 6. Credential keys | `apps/sdp-api/src/types/env.d.ts` | `<ID>_API_KEY` + `<ID>_SANDBOX_API_KEY`. `keyPairCredentialDefinition` binds its derived keys to `keyof Env`, so skipping this is a compile error. |
| 7. Key projections | `turbo.json` `globalEnv` + `scripts/secret-keys.mjs` | Both keys in both files (+ the secret manager for deployed environments). |
| 8. Managed deployments | sdp-infra `terraform/envs/<env>/terraform.tfvars` | Append the credential key(s) to `app_secret_keys` (the Doppler → Secret Manager mirror; also add the value to that env's Doppler config). Dev carries sandbox keys only — production keys are a launch-gated decision (PRO-1647). Nothing else: the Cloud Run service and Job read the same secret set, and the hourly catalogue sync picks the provider up from `EARN_PROVIDER_CLIENTS` with zero job changes (`src/job.ts` never names providers; an un-credentialed provider skips fail-closed with `PROVIDER_NOT_CONFIGURED`). |
| 9. Kora allowlist (executing providers only) | `infra/kora/kora.toml` + sdp-infra `kora/cloud-run/kora.{devnet,mainnet}.toml` | A vault-direct client must implement `sponsoredPrograms(cluster)`, a REQUIRED member of `EarnVaultDirectProvider`, and every id it returns has to be in all three allowlists or Kora rejects the whole sponsored transaction. `vault-sponsorship-allowlist.test.ts` fails CI on the local file; the deployed pair is covered by the live Kora smoke suite, which is opt-in until sdp-infra#64 deploys. Catalogue-only providers skip this step. |

### The keyless variant (public API — Kamino)

A provider whose data API takes no credential does steps 1–4 unchanged, then:

- **Step 5** becomes `<id>: publicApiDefinition("<Label>")` — `isConfigured`
  answers true because there is nothing to configure: no key to be missing, no
  sandbox account to mistake for production, no tenant to point at wrongly.
- **Steps 6, 7 and 8 are SKIPPED, deliberately.** Do not add placeholder
  `<ID>_API_KEY` entries "for consistency": `scripts/secret-keys.mjs` is "every
  env key the SDP API reads" and projects into the local and Docker env files,
  so a declared secret nothing reads is a standing question for whoever next
  provisions the service. Nothing goes into sdp-infra either.
- **Add the id to `KeyPairedEarnProviderId`'s exclusion** in
  provider-availability.service.ts. That type is what stops
  `keyPairCredentialDefinition` from requiring a `keyof Env` entry that will
  never exist.

Entitlement is unaffected: a keyless provider still defaults to disabled, since
entitlement and configuration are separate gates. A catalogue-only provider
simply never reaches the entitlement gate, which only guards money-in.

### If the provider is not deployed on every cluster

State it on the snapshot. `ProviderStrategySnapshot.hostCluster` is the cluster
the INSTRUMENT lives on, and it is not implied by the environment. One predicate,
`isClusterFundableInEnvironment`, enforces that everywhere. Do not reach for
`status` — it is the operator's stop switch and the repository refuses to
overwrite it.

**But first: check whether the provider really has no devnet deployment.** Kamino
was catalogued mainnet-into-both-environments for exactly one reason — we
believed it had none. It does (2026-08-14 addendum), and the cost of that belief
was a sandbox shelf where every row was permanently `fundable: false`. A hosted
API that ignores an `env` parameter is not evidence: Kamino's returns 200 with a
byte-identical mainnet payload. Check the chain for a per-cluster program before
you conclude a provider is single-cluster.

**And non-production may never STORE a mainnet instrument.** The catalogue sync
refuses any snapshot whose `hostCluster` is `mainnet-beta` outside production,
provider-neutrally, at the single writer. If your provider genuinely is
mainnet-only, it contributes nothing to a sandbox catalogue — that is the
intended outcome, not a gap to work around.

### A new catalogue column is EXPAND-ONLY in the release that adds it

If your provider needs a column no existing row has, add it **nullable** and
backfill it — do not add `NOT NULL` in the same release, however required the
field is on the TypeScript input.

`deploy-sdp-api-gcp.yml` runs migrations BEFORE it rolls the service and before
it updates the cron job image, and a rollback restores the previous image over
the already-applied schema. So the previous release's catalogue writer — whose
INSERT does not list your column — writes into the new schema in both windows. A
`NOT NULL` fails every one of those upserts, including the `ON CONFLICT` path,
which stalls the catalogue refresh for as long as the old image is live.

The contract half (`SET NOT NULL`) belongs in a later release, once no
deployable writer predates the column. Until then the nullability is not a hole
in the invariant, provided both halves hold:

- the snapshot/`Upsert…Input` field is REQUIRED, so every writer on this release
  states it; and
- the repository's row mapper resolves a NULL to the same value the backfill
  would have written (see `mapStrategyRow`, which derives `host_cluster` from
  the row's `environment`). Failing closed there is worse than useless — it
  would drop live rows out of the product for a condition the writer, not the
  row, is responsible for.

Pin both halves with a test that INSERTs a row omitting the column and asserts
the read resolves it (`earn.repository.test.ts` → "admits a row from a writer
that predates host_cluster").

Tests that enforce the checklist (run them; they fail on the exact step you
missed):

- `packages/sdp-earn/src/index.test.ts` — every `EARN_PROVIDERS` id has a
  registry entry with a matching `provider` field and a `package.json`
  subpath export (steps 3–4).
- `apps/sdp-api/src/services/provider-availability.drift.test.ts` — every
  credential key an availability definition actually READS appears in
  `turbo.json` `globalEnv` and `scripts/secret-keys.mjs` (step 7), plus an
  inverse guard so a credentialed provider cannot slip through by declaring no
  keys at all.

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
provider actually offers it. Note the capability is weighted by design, but
the V1 product caps each token group at ONE allocation entry per program
(PRO-1667, ADR 0002 addendum) — a new provider only ever receives
single-vault targets until weights are re-enabled post-V1.

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
4. **Idempotency.** A withdrawal **and a program create** each require EXACTLY
   one caller-supplied key — `requestId` (UUIDv4) or the `Idempotency-Key`
   header — and 400 on both or neither, because no precedence rule can tell
   which one a caller's retry holds stable. Only the re-target is looser
   (it moves no money and re-applying the same allocations is a provider
   no-op), and the client may still generate a UUIDv4 there when omitted;
   `EarnPortfolioWalletCreateInput.requestId` is a REQUIRED field precisely so
   no client can silently mint one on the create path (PRO-1670).
   The key is never forwarded as given: `deriveProviderRequestId` hashes it
   against a scope, so two organizations sharing one provider account cannot
   collide on the same pasted value. The scope differs by operation and that is
   the interesting part — a withdrawal and a re-target derive against the
   program wallet (which also stops one caller key used against two of an org's
   own programs from collapsing into one mutation), while a create has no wallet
   yet and derives against `(organization, environment, provider)`. A provider
   requestId-conflict error surfaces as `CONFLICT`.
5. **Persistence.** N programs per org+environment+provider, each one link row
   in `earn_provider_wallets` (migration `0049_earn_provider_wallets.sql`;
   `0056_earn_multi_program.sql` lifted the original one-per-org cap), via
   `EarnRepository.listProviderWallets` / `getProviderWalletById` /
   `getProviderWalletByRef` / `insertProviderWallet`. The surviving uniqueness
   is GLOBAL on `(provider, provider_wallet_ref)`: a provider wallet holds real
   funds, so exactly one link row anywhere in the platform may claim it. That
   constraint is also the create path's replay anchor — the provider answers a
   retried create with the ORIGINAL wallet ref, so the second insert lands on it
   and the handler reads the row back and serves it (200). Treating that
   violation as a conflict would turn the required idempotency key into the
   double-provisioning it exists to prevent; a ref held by a *different* org or
   environment is the one case that really is a conflict.
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

## 4c. Implementing the live-metrics capability — fresh rates

The catalogue sync runs hourly because catalogue *drift* is slow. Rates are not,
and an hour-old APY on a comparison table is a number a customer compares vaults
by and then moves money on. A provider that can serve its whole shelf's current
figures in a call or two implements `EarnLiveMetricsProvider`:

```ts
async listStrategyMetrics(ctx: EarnRuntimeContext): Promise<ProviderStrategyMetrics[]>
```

`supportsLiveMetrics` discovers it, and `cron/earn-metrics-refresh.ts` refreshes
those figures in place every 5 minutes. Nothing else to wire — both schedulers
already iterate the registry.

Three things to understand before opting in:

- **It is a promise about COST.** The pass runs 12× more often than the sync.
  Kamino qualifies because one bulk endpoint carries every vault's figures in
  two requests. Ground does NOT implement it: its rates arrive on the same paged
  yield-sources endpoint the catalogue uses, so a five-minute pass would re-pay
  the whole catalogue cost for the rate alone.
- **Return your whole shelf, unfiltered.** The refresh is UPDATE-only —
  `updateStrategyMetrics` no-ops on any reference the catalogue does not hold —
  so reporting vaults that distillation refused costs one no-op per row and
  saves you re-running the admission gates. Kamino reports 173 and 21 land.
- **Figures only.** `ProviderStrategyMetrics` carries the rate and volatile risk
  metadata (TVL, holders) and nothing that could change what a strategy *is*.
  The metadata is merged over what is stored, so `curator` — which the hourly
  sync derives — survives. Keep it that way: the narrow input is what makes the
  pass safe to run unslotted.

Why this writes to the DB rather than reading live at request time:
`GET /strategies` reads exactly ONE source for the state it reports (ADR 0002,
2026-08-11 addendum). Freshness is cadence, not blending.

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

## 6. Un-surface a provider — stop offering it without deleting it

"We are not selling this provider right now" is a different question from every
switch in ADR 0002's enable/disable list, and answering it by deleting the
integration, pulling its credentials, or pausing its strategies one by one all
lose information you want back later.

**The whole change is one boolean.** In
`packages/sdp-types/src/provider-access.ts`:

```ts
export const EARN_PROVIDER_SURFACING = {
  …
  ground: false,   // ← un-surfaced
  kamino: true,
} as const satisfies Record<EarnProviderId, boolean>;
```

Nothing else. Three consumers read it and none of them names a provider:

| Surface | Effect |
|---|---|
| `GET /v1/earn/strategies` (list + detail) | Rows hidden. The list filters in SQL (`providers: SURFACED_EARN_PROVIDERS`) so `total` and the page window describe what the caller can see; the detail route 404s via `isHiddenStrategy`. |
| `POST /v1/earn/programs` | 403 `"… is not currently offered."` (`assertEarnProviderSurfaced`), refused before the provider is called. |
| Dashboard | `EARN_PROGRAM_CREATION_ENABLED` drops the onboarding CTA, "Add strategy", "Change strategy", and the `/deposit` route itself. |

### What un-surfacing must never do

Money out beats money off, so the switch gates the way IN and nothing else.
**Every route that reads or exits an existing program ignores it**: the programs
list and detail, deposits, withdrawal previews, withdrawals, the ledger, and
`PUT /programs/:programId` (re-targeting a position already taken). An
organization holding a program with an un-surfaced provider loses no access to
its money — it loses the ability to open a new one.

Two things that look like bugs and are not:

- **`assertKnownYieldSources` still accepts hidden rows.** It validates against
  the STORED catalogue, so an existing program may keep pointing at a strategy
  the browse surface no longer shows. Making it inherit the hide would freeze a
  customer's allocation over an editorial decision about new customers.
- **The catalogue sync keeps syncing it, and the metrics refresh keeps
  refreshing it.** `earn_strategies` stays a truthful provider inventory and
  re-surfacing takes effect on deploy rather than after the next hourly pass.
  Un-surfacing is not a reason to remove credentials — that is a *different*
  switch (503 `PROVIDER_NOT_CONFIGURED`) that would also break the exit path.

### Before you flip one

**Check what the provider is load-bearing for.** Ground is the only
portfolio-capable provider today, so un-surfacing it leaves nothing that can
create a program and Earn becomes browse-only. That may be exactly what you
want — it is what shipped on 2026-08-14 — but it is a product decision to make
deliberately, not a side effect to discover in the dashboard.

Rule of thumb: if every surfaced provider fails `supportsPortfolioWallets`,
there is no deposit flow left.

### The dashboard trap: never read a surfacing constant out of a client module

`EARN_PROGRAM_CREATION_ENABLED` lives in
`apps/sdp-web/src/app/dashboard/markets/earn/earn-surfacing.ts`, which carries
**no `"use client"` directive**, and that is load-bearing. A Server Component
importing a *value* from a client module gets a **client-reference proxy, not the
value** — an object, therefore always truthy — so `if (!FLAG)` silently becomes
dead code. That is exactly what happened to `deposit/page.tsx`'s guard on the
first pass: the route rendered the whole wizard with no provider that could
create anything.

`tsc` passes (the types are right), unit tests pass (they mock the module), lint
is silent. **Only a browser catches it**, so finish a surfacing change by loading
`/dashboard/markets/earn` and `/dashboard/markets/earn/deposit` for real.

### Tests

A suite that exercises money-in for a provider you just un-surfaced will fail,
and the fix is *not* to weaken the gate. `earn-program.test.ts` partial-mocks
`isEarnProviderSurfaced` to force surfacing ON, so the create machinery
(idempotency, replay, gate order, environment isolation) stays tested
independently of today's business config, and the gate gets its own
`describe` that flips the mock off and runs against the real map. Catalogue
tests (`earn.test.ts`) seed a **surfaced** provider by default for the same
reason. Copy that pattern rather than editing the map to make a test pass.
