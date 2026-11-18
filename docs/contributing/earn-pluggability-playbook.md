# Earn pluggability playbook

Earn aggregates strategies through one catalogue and one async operation
lifecycle. A strategy can be a vault, lending market or RWA. Treasury and
Embedded Yield use the same core API. Provider integrations add capabilities,
not product-specific HTTP routes.

See the [core contract](../architecture/earn-core-api-proposal.md) and
[threat model](../security/earn-core-api-threat-model.md) before changing
execution or recovery. The replacement remains internal pending security
sign-off. Registration does not authorize public API publication.

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

Start `EARN_PROVIDER_SURFACING` at `false`. Complete these registrations before
surfacing the provider:

1. Add the ID to `EARN_PROVIDERS` in
   `packages/sdp-types/src/provider-access.ts`. Fill every exhaustive policy map,
   including surfacing, deposit style and deposit/withdrawal slippage floors.
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
4. Add its dashboard label and complete all exhaustive cluster and provider
   registries. A sandbox HTTP environment does not prove a devnet deployment.
5. Implement only capabilities needed by a supported strategy. Unsupported
   allocation programs and portfolio-wallet contracts are outside this API.

Unknown IDs fail closed. Provider HTTP uses `providerFetch` or
`providerFetchJson`, with sanitized errors. Keep chain SDKs in execution
packages, so catalogue cron processes do not load them.

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

Register the execution singleton in both
`apps/sdp-api/src/services/earn-provider-registry.ts` and
`apps/sdp-api/src/services/earn/execution-registry.ts`. Downstream code narrows
through capabilities. A new integration should reuse the core routes and
shared operation worker without adding another execution contract.

Pin program IDs and mints by cluster in `@sdp/types`. Plan-target checks and
`sponsoredPrograms` must derive from the same deployment registry. A missing
deployment remains unavailable; never substitute another cluster's addresses.
Wire a new execution package into the API workspace dependencies and Dockerfile
COPY lists. Dependencies stay exact-pinned with the lockfile committed.

## Signing and async execution

The core API prepares deposits by strategy/source/token amount and withdrawals
by position/quantity. Preparation quotes, enforces floors and simulates before
returning reviewable terms, an action ID/version and unsigned transaction bytes
or the next action. Preparation never starts wallet signing or broadcasts.

API clients normally use an SDP API key and `source: { ownerAddress }`. Any
compatible Solana wallet can sign the returned transaction through the client's
integration, without an SDP wallet record or provider connection. Require the
prepared owner and every other signer to sign the unchanged message, then accept
base64 `signedTransaction` through the shared operation contract.

An existing connected wallet's `source: { walletId }` is optional. A source
changes signing authority, not the API flow.
`POST /v1/operations/{operationId}/submit` authorizes
and durably queues the exact reviewed transaction, returning `202`. It never
prepares an action. Configured signing, custody proposals and broadcast run in
the shared worker, including fast signers.

Withdrawal choices use `nextAction: select_option` and `terms.options`. Refresh
requires the current `actionId`, `version` and an advertised `optionId`, then
returns a new transaction review. Ordinary refresh omits `optionId` and retains
the selected route. An unavailable route must fail instead of switching.
Refresh only prepares unsigned bytes and terms before submit acceptance; it
never signs or broadcasts. After any accepted submit, both refresh and cancel
return `409 CONFLICT`. Definitive rejection or proven nonexecution is terminal
`failed`, not an opportunity to refresh. A new request/key may retry only after
known failure; uncertainty never permits another operation.

Consumers use `canCancel`, not status, source kind or elapsed time, to decide
whether to offer cancellation. It is false after any accepted submit and while
an exposed owner transaction outcome is unknown.
The cancel route still checks its own permission. Provider signing cleanup for
permission loss or expiry is internal, not a post-submit API cancellation.

Compose funding swaps and deposits atomically. Size deposits to the swap's
guaranteed output, retain live simulation and compact-route retry, and reject
an oversized composition before persisting a build. Never introduce a standalone
funding swap or a follow-up deposit review.

Configured-wallet signing remains asynchronous under `awaiting_signature`.
Use `sign_in_provider` for instructions such as "Sign in Fireblocks".
Provider-side approvals belong to wallet signing policy; they do not create a
separate Earn approval API or require another submit call after signing.

Use `createOrgSignerForCustodyWallet` and the shared sponsorship boundary with
`MOVEMENTS`. A new custodian belongs in the custody family, not an Earn adapter.
Partner-paid transactions preserve both owner and fee-payer signatures. The
worker verifies the entire prepared message and all required signatures.

Keep these invariants when adding a capability:

- Mutations validate and authorize named resources before shared idempotency.
  Every money mutation requires a persisted `Idempotency-Key`.
- Workers restore the original principal and recheck current grants, credentials,
  wallet bindings and admission before a new effect.
- Persist exact signed bytes and attempt identity before submission. Retry an
  uncertain response with the same body and key. Missing RPC history, timeout
  or blockhash expiry alone cannot justify replacement or a second proposal.
- Signing, chain inclusion, queue closure and delivered assets remain
  separate observations. Never copy estimates into settled fields.
- New terms need a new explicit review. Public cancellation cannot cross the
  first submit acceptance; internal cleanup preserves unresolved outcomes.

Sponsorship programs must appear in `infra/kora/kora.toml` and the deployed
sdp-infra devnet/mainnet allowlists for the relevant cluster. The local
`vault-sponsorship-allowlist.test.ts` proves declared coverage. Live Kora checks
are conditional and must be reported as run or skipped. Caller-provided fee
payers do not use Kora and need their own signature coverage.

## Rates and RPC cost

The hourly catalogue sync admits strategies. A provider with a cheap bulk-rate
endpoint may additionally implement `EarnLiveMetricsProvider` for the five-minute
refresh. Return the complete shelf; metrics updates cannot admit a new strategy.
Fail an incomplete paginated catalogue read instead of delisting unseen rows.

Unknown APY or observation time stays unknown. Discovery reads the persisted
catalogue rather than blending unrelated request-time values. An exchange rate
alone is not an APY.

Follow `packages/sdp-earn/CLAUDE.md`'s RPC budget: reuse clients, batch independent
accounts, cache static facts without failures, coalesce identical authorized
reads and never fetch one input twice. Quotes and builds read every value-bearing
input live. State before/after request counts when modifying these paths.

The atomic-only change leaves successful deposit RPC counts unchanged: one
compute probe and one final simulation. Oversized requests lose the former
baseline balance read and two standalone-swap
simulations; they do not create swap-status polling or a second deposit build.

## Pause or hide a provider

`EARN_PROVIDER_SURFACING` controls new exposure. Hiding a provider does not remove
its credentials, strategy records, positions or exit capability. An operator
pause must survive catalogue refresh. Keep reads and withdrawals available for
held positions, independent of new-deposit entitlement or surfacing gates.

Catalogue sync and metrics refresh continue for hidden integrations so stored
holdings and later re-surfacing use truthful metadata. Do not make a client-side
visibility flag a server authorization control.

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
