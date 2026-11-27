# Earn provider integration and offering controls

This is the single maintenance guide for adding providers, changing their
strategies, pausing new exposure and restoring an offering. Keep procedures
and propagation timing here; other guides link here instead of copying steps.
Paths below are relative to the repository root. `CLAUDE.md` in this directory
loads this file for Claude; Codex reads `AGENTS.md` directly.

Earn aggregates strategies through one catalogue and one async operation
lifecycle. A strategy can be a vault, lending market or RWA. Treasury and
Embedded Yield use the same core API. Provider integrations add capabilities,
not product-specific HTTP routes.

## Choose the control

- Add a new protocol or issuer integration: follow [Register a provider](#register-a-provider).
- Add or change a vault in an existing integration: change that provider's
  catalogue source or approved deployment registry, not the core routes.
- Hide an entire provider and refuse new deposits: follow
  [Hide and restore an offering](#hide-and-restore-an-offering).
- Limit individual strategies' deposit eligibility: use the execution shelf
  in `apps/sdp-api/src/routes/earn/handlers/curation.ts`. `HIDDEN_VAULTS`,
  `CURATED_VAULTS` and `HIDDEN_STRATEGY_TERMS` affect deposit admission; core
  discovery intentionally retains those rows as `catalogue_only`. They are
  not equivalent to provider-wide hiding.
- A stored strategy's `paused` or operator-owned `deprecated` status stops new
  deposits and preserves exits. No strategy-status mutation endpoint exists;
  do not invent one or treat a credential removal as a pause.
- Organization `providerOverrides.earn` changes deposit entitlement, not the
  global discovery shelf. Credentials and real cluster deployment are separate
  execution prerequisites. See [When changes appear](#when-changes-appear).

See the [core contract](../../../../docs/architecture/earn-core-api-proposal.md) and
[threat model](https://www.notion.so/422d36dad52d81e2bcf2cbd62c8e4622) before
changing execution or recovery. Publication follows Earn's existing module tags and
release-channel rules. Provider registration does not change those rules.

## Catalogue changes

Curators are data in `risk_metadata.curator`. Unknown IDs render through
`earnCuratorLabel`; optional display labels live in `EARN_KNOWN_CURATOR_LABELS`
in `packages/sdp-types/src/earn.ts`. Derive attribution from provider-verified
fields or authorities, never a permissionless strategy name. The same evidence
requirement applies to a strategy's RWA classification.

Closed category values live in `packages/sdp-types/src/earn.ts`, including
source kind, APY type, liquidity term and supported deposit-token symbols.
Their database fields are open text or JSONB, so extending a code union does
not itself need a migration. Extend the provider's `declaredSupport` too.
Deposit mints must resolve through the shared well-known token catalogue.
Discovery filters derive from the shared enums.

Declare participation defaults with the provider descriptor: `requiresKyc`,
`requiresKyb`, `geographicallyRestricted` and `termsUrl`. A catalogue snapshot
can provide typed `riskMetadata.participation` overrides for a particular
strategy. The API projects the resolved values as always-present top-level
strategy fields; existing rows inherit provider defaults without a resync.

Use `true` for source-confirmed requirements or restrictions, `false` only
for confirmed absence on that route, and `null` for unknown or conditional
cases. Do not infer no KYC from a permissionless transfer or no geographic
restrictions from a keyless API. Terms links must be verified HTTPS provider
or product terms, never a homepage standing in for an unknown agreement.
Record source provenance when adding or changing these declarations.

This is descriptive metadata, not customer approval or authorization. It does
not add IP geofencing, terms acceptance storage or a withdrawal gate. Provider
terms can be supplemented by product-specific agreements; one URL does not
claim to enumerate all agreements.

Deploy the API producer before the dashboard consumer: the shared dashboard
schema requires all four fields and rejects older discovery payloads. Adding
the metadata makes no provider or RPC calls; defaults apply to existing rows
without waiting for a catalogue resync.

`earn_strategies` rows are keyed by provider, provider reference and environment.
The hourly `apps/sdp-api/src/cron/earn-catalogue-sync.ts` calls registered
`listStrategies` clients, validates their declared support and admits rows
through `earn.repository.postgres.ts`. Provider failures are isolated. Do not
seed rows that bypass this validation.

Sync updates catalogue-owned fields. Operator `paused` and `deprecated` statuses
survive later syncs. Delisting or pausing stops new deposits, while existing
positions retain their exit metadata. Never delete a strategy referenced by
positions or movements. Deposit admission and withdrawal availability are
separate policies.

## Register a provider

Start the provider's `surfaced` at `false`. Collect the provider evidence
below, then complete the registrations. Enable the offering only after
[Verification before surfacing](#verification-before-surfacing).

### Required provider evidence

Record authoritative provider docs or pinned source for the route SDP will
actually offer, including:

- Asset/share mints, decimals, token programs, program authorities and verified
  deployments for each cluster. An HTTP sandbox is not proof of devnet support.
- The complete deposit and withdrawal paths, exact amount/floor semantics,
  fees, rent, liquidity and any intermediate assets the owner can retain.
- Whether source finality means atomic delivery or only opens an order/escrow;
  settlement identifiers, authenticated payout evidence and recovery behavior.
- Signing requirements, third-party signatures, transaction/quote lifetimes,
  and how delayed approvals, timeouts, restarts and ambiguous results recover.
- Provider/integrator credentials and any customer onboarding or wallet
  permissioning. Distinguish partner KYB from the investing customer's rules.
- Verified HTTPS terms and published KYC/KYB/geographic requirements for the
  actual product. Unknown or conditional requirements remain `null`, not false.

Missing evidence leaves the provider hidden. Do not substitute a successful
catalogue read for a verified signing, delivery and exit integration.

### Required registrations

1. Add the ID to `EARN_PROVIDERS` and its entry to `EARN_PROVIDER_DESCRIPTORS`
   in `packages/sdp-types/src/provider-access.ts`. The descriptor states every
   policy: surfacing, deposit style, settlement, slippage floors, deployed
   clusters and participation defaults. The per-policy tables are derived from it.
   Earn entitlement is override-only; registration grants no organization access.
2. Add an SDK-free catalogue client under
   `packages/sdp-earn/src/providers/<id>/client.ts`, its entry in
   `EARN_PROVIDER_CLIENTS` and its package subpath export. Declare the supported
   categories, tokens and real `hostCluster` on every snapshot.
3. Register availability and any provider credentials in the API's shared
   provider definitions. A keyless upstream adds no placeholder secret. A new
   credential must appear in API `env.d.ts`, `scripts/secret-keys.mjs`,
   `turbo.json` and the managed secret projection for both API and cron
   services.
4. Implement the supported [execution capabilities](#execution-capabilities)
   in `packages/sdp-<id>` when SDP executes. Add the API workspace dependency
   and both package-manifest and source COPY entries in
   `apps/sdp-api/Dockerfile`; register the shared execution factory once.
   Catalogue-only integrations use an explicit `null` execution factory.
5. Add the dashboard label to `EARN_PROVIDER_LABELS` in
   `apps/sdp-web/src/app/(session)/dashboard/[projectId]/markets/earn/earn-format.ts`
   and complete all exhaustive provider/cluster registries the compiler flags.
6. Update API descriptions, current consumers and authored docs together. Follow
   the owning generators and checks below before a separate surfacing decision.
   Unsupported allocation programs and portfolio-wallet contracts are outside
   this API. Do not create provider-specific routes or a second operation worker.

Unknown IDs fail closed. Provider HTTP uses `providerFetch` or
`providerFetchJson`, with sanitized errors. Keep chain SDKs in execution
packages, so catalogue cron processes do not load them. Parse every caller
amount with `acceptTokenAmount` (`@sdp/solana/amount`), the one grammar every
execution package shares, and map its refusal reasons to the package's own
`INVALID_AMOUNT` errors.

## Execution capabilities

An executing provider adds a client in `packages/sdp-<id>` implementing the
applicable interfaces in `packages/sdp-earn/src/types.ts`:

- `EarnVaultDirectProvider` builds deposits, reads positions and declares
  `sponsoredPrograms(cluster)`. All three are required by `supportsVaultDirect`.
- `EarnVaultWithdrawProvider` separately builds exits. Deposit support never
  implies withdrawal support.
- Deposit and withdrawal quote capabilities derive required protection floors.
  Builders must report exactly the admitted token identities, amount and floor.
- Queued withdrawal capabilities cover request, observation and cancellation.
  Share escrow is not payout; verified provider or chain observations establish
  delivery. Provider cancellation capabilities remain internal; the public
  operation cannot be cancelled after submit. Delayed settlement remains under
  the same operation without a separate claim endpoint.
- Provider-order settlement, preparation, cancellation and onboarding remain
  distinct capabilities when a strategy needs them. Eligibility is independent
  of authorization to move funds.

Register one factory in `EARN_EXECUTION_FACTORIES` in
`apps/sdp-api/src/services/earn/execution-factories.ts`. Its exhaustive provider
map uses `null` for catalogue-only integrations. Both the API singleton
registry and operation-scoped registry call this factory; neither needs a
second provider entry. Constructors perform no I/O and resolve credentials
only when an operation uses them. Downstream code narrows through capabilities.

Use `EarnVaultOperationRunner` and `EarnProvenRpcResolver` from
`@sdp/earn/types` for the API-owned deadline and verified endpoint. Keep
provider-specific deployment validation and error mapping in the adapter.
Shared execution does not require a separate RWA superclass.

For issuer orders or cross-chain delivery, implement
`EarnProviderSettlementProvider.readProviderSettlement` with the shared
`EarnProviderSettlementInput` and `EarnProviderSettlementCandidate` types.
Return the source-correlated destination transaction, expected token, program
and required account. This is a candidate: the shared API verifier independently
checks finalized delivery to the recorded owner before closing the operation.
A pending or recovery-required response must not invent delivery. Registry tests
refuse to launch a surfaced, deployed provider-order integration without this
observation capability. Keep an unfinished integration hidden and undeployed.

A provider using the shared swap port can use `buildSwapLegWithFloor` from
`@sdp/earn/swap-floor` to prove its caller-approved output floor. The adapter
validates quoted and built amounts at the correct token scale, chooses mints
and payer, and maps errors. The helper derives tolerance, checks the built
threshold and retries once at zero tolerance. It never signs or submits.
A normal attempt still uses one quote and one build; a floor retry adds one
build. Keep the core routes and operation worker for every new provider.

Pin program IDs and mints by cluster in `@sdp/types`. Plan-target checks and
`sponsoredPrograms` must derive from the same deployment registry. A missing
deployment remains unavailable; never substitute another cluster's addresses.
Dependencies stay exact-pinned with the lockfile committed.

## Signing and async execution

Use the shared operation lifecycle described in the
[Earn route guide](../../../../apps/sdp-api/src/routes/earn/CLAUDE.md#execution-and-async-recovery).
Keep provider-specific signing or broadcast orchestration out of the adapter.

- Builders return reviewable terms and plans, never signatures or submissions.
  The API supports both external owners and connected custody wallets.
- Preserve admitted immutable `providerTransaction` messages, existing protocol
  signatures, payer and blockhash. Do not recompile them to add instructions.
- Use the shared signer/sponsor boundaries and asynchronous custody proposals.
  Persisted identities, exact signed bytes, current authority and worker leases
  remain authoritative across retries and restarts.
- Delayed signing must respect transaction/quote lifetime. Do not silently
  refresh an accepted operation or create another proposal after ambiguity.
- Implement real deposit eligibility independently from metadata when required.
  The core checks it before preparation and broadcast, including after custody
  approval; observation and exits do not acquire a deposit gate.
- Source confirmation, escrow, provider completion and actual payout are
  separate evidence. Keep unknown amounts unknown and correlate finalized
  receipts with the original owner, instrument and source action.

Sponsorship programs must appear in `infra/kora/kora.toml` and the deployed
sdp-infra devnet/mainnet allowlists for the relevant cluster. The local
`vault-sponsorship-allowlist.test.ts` proves declared coverage. Live Kora checks
are conditional and must be reported as run or skipped. Caller-provided fee
payers do not use Kora and need their own signature coverage.

## Rates and RPC cost

Catalogue ingestion admits rows; optional `EarnLiveMetricsProvider` updates
existing figures only. Return complete provider reads rather than letting
partial pagination falsely delist strategies. Unknown APY or observation time
stays unknown; an exchange rate alone is not an APY. Cadences are listed under
[When changes appear](#when-changes-appear).

Follow the [shared RPC budget](../../CLAUDE.md#rpc-budget-hard-rule): reuse
clients, batch independent accounts, share identical authorized reads and avoid
fetching an input twice. Quotes and builds read every value-bearing input live.
State before/after request counts when changing these paths.

## Hide and restore an offering

1. Change only `EARN_PROVIDER_DESCRIPTORS[provider].surfaced` in
   `packages/sdp-types/src/provider-access.ts`: `false` hides the entire
   provider from discovery and refuses new deposits; `true` offers it again.
   This is compiled policy, not an environment variable or database toggle.
2. Deploy the API and cron/operation-worker revisions using normal release
   controls. Fresh API reads and preparation use the new API policy; queued
   deposits recheck it on their next advance in the updated worker. Verify the
   intended revisions are serving before calling the change effective.
3. Verify discovery using the correct project environment and instrument
   cluster, new-deposit refusal when hidden, and the existing holding's read
   and withdrawal paths. Refresh/reload an already open dashboard.

Keep the client, execution factory, deployments, credentials, strategy rows,
positions and provider observers registered. Removing any of those can break
held-position reads, exits or settlement; it is not a way to pause exposure.
Catalogue ingestion and supported metrics refresh continue for hidden providers.
Do not delete held strategies or stop financial reconciliation.

A hide is not an on-chain revocation. Already exposed signed bytes may still
land; retain and reconcile the original attempt. Missing RPC history, a timeout
or a pending cancellation is not proof of nonexecution. Never replace an
uncertain signing proposal or order just because the offering is now hidden.

Restoring `surfaced: true` neither grants organization entitlement nor unpauses
strategies. Check active status, execution-shelf selection, real cluster support,
configuration, live eligibility, exposure limits and the existing launch gates.
Operator pauses remain sticky across syncs. Only sync-owned delist tombstones
can reactivate automatically when their provider lists them again.

Tracked withdrawals and recovery never inherit surfacing, new-deposit
entitlement, issuer deposit eligibility or exposure-cap gates. They retain normal
source authorization and provider execution/liquidity requirements. Hiding also
limits discovery of untracked external holdings; do not confuse that catalogue
coverage policy with the retained tracked-position exit path.

## When changes appear

All deployment times below mean the new revision is actually serving, not just
that code was merged. These are healthy-path ingestion intervals, not an SLA.

| Change                                            | First effect                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| New provider or newly listed strategy             | First successful catalogue ingestion, normally within about 64 minutes plus processing, followed by applicable offering/admission checks. |
| Hide or restore already indexed provider          | Fresh API request after API rollout; no catalogue sync required.                                                                          |
| Queued deposit after a hide                       | Next worker advance under the updated cron revision; backoff can delay that observation.                                                  |
| Provider participation default                    | Fresh API read after rollout; existing rows need no resync.                                                                               |
| Strategy-specific metadata from provider snapshot | Next successful catalogue ingestion.                                                                                                      |
| Organization entitlement                          | Next admission read after the authorized settings change; discovery is unchanged.                                                         |
| Live rate/TVL metrics                             | Five-minute refresh for providers implementing live metrics; otherwise the catalogue cadence. Metrics cannot admit new strategies.        |

`earn-catalogue-sync.ts` checks every five minutes and attempts on worker start,
but `EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS = 3540` limits ingestion to roughly
hourly. Startup respects an existing shared Redis slot. Earn's module gate,
provider credentials, RPC access and reliable complete reads are still required;
outages can defer ingestion beyond the normal interval. A failed/partial pass
retains prior rows instead of falsely delisting them.

If changing cadence, review the cron `schedule`, slot TTL and bounded sync
deadline together in `apps/sdp-api/src/cron/earn-catalogue-sync.ts`. The slot
must outlive a permitted sync; changing only the schedule does not change the
effective cadence. Keep the slot/deadline regression tests aligned.

Direct discovery responses permit 30 seconds of private caching. The dashboard
proxy uses `no-store`, but the strategy hook does not poll or refetch on focus:
an open list needs Refresh/reload. A stale list never authorizes a deposit;
preparation and worker admission enforce current server policy.

## Verification before surfacing

- Catalogue tests cover declared support, real clusters, complete pagination,
  unknown values and sanitized failures without network access.
- Registry and availability drift tests cover every provider ID, capability,
  configuration key and deployment entry.
- Builder tests cover token/share identities, canonical amounts, floors,
  sponsorship and both owner-paid and partner-paid signatures where supported.
- Core/worker/repository tests cover authorization, exact-byte replay, revocation,
  uncertain execution, queued settlement, cancellation and tenant isolation.
- Provider refusals map to caller-actionable errors; RPC outages and unavailable
  live state map to sanitized retryable errors; unknown failures stay errors.
- Run affected package tests, API tests, workspace typecheck, lint, value-movement
  checks and migration compatibility checks for schema changes.
- Update OpenAPI descriptions, authored Earn guides, integration examples and
  current clients together. Regenerate OpenAPI, inventories, playground, API
  reference, Postman, AI resources and module map with their owning scripts.
- Prove the relevant provider sandbox deposit, signing, position read,
  withdrawal and actual settlement. State which live flows and signed-in browser
  steps were verified; local tests do not establish those outcomes.

Do not surface an integration that passes catalogue tests but lacks a complete,
reviewed execution and exit path for its advertised capabilities.

## Focused checks

Run from the repository root. Also run the new provider package's own tests and
typecheck using its real package name, and the required workspace/CI checks.

```bash
pnpm --filter @sdp/earn test
pnpm --filter @sdp/api exec vitest run \
  src/services/earn-provider-registry.test.ts \
  src/services/earn/execution-registry.test.ts \
  src/services/provider-availability.service.test.ts \
  src/services/provider-availability.project.test.ts \
  src/routes/earn/strategy-catalogue.test.ts \
  src/routes/earn/core/operation-flow.test.ts \
  src/cron/earn-catalogue-sync.node.test.ts
pnpm check:module-boundaries
pnpm check:value-movement
```

The Ondo operation-flow regression proves hidden discovery, refusal before
building/signing, and a tracked deprecated position's withdrawal despite
disabled deposit entitlements. The catalogue test proves hidden providers keep
ingesting. Extend these behaviors for changed capabilities; do not replace them
with a test that only asserts the value of `surfaced`.
