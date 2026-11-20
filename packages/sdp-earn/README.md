# @sdp/earn

`@sdp/earn` aggregates provider strategies for SDP. A strategy can be a vault,
lending market or RWA product. Treasury and Embedded Yield wrap the same
catalogue, positions and asynchronous actions.

Catalogue clients declare their supported sources and publish strategy metadata.
Execution adapters live in their provider packages and expose the capabilities
that each strategy actually supports. Discovery does not imply deposit access,
liquidity or signing authority.

A position records a wallet's holding in a strategy. An operation tracks one
deposit or withdrawal, including signing, submission and provider settlement.
Program creation, allocation configuration and their HTTP routes are removed.
The movement ledger records the financial outcome of current operations.

Companion docs:

- [Core API design](../../docs/architecture/earn-core-api-proposal.md)
- [Threat model](../../docs/security/earn-core-api-threat-model.md)
- [Provider playbook](../../docs/contributing/earn-pluggability-playbook.md)
- [Historical V1 design](../../docs/architecture/earn-v1-data-flow.md)

## Strategy actions and wallet signing

Treasury and Embedded Yield use the same four core routes. A strategy may be a
vault, lending market or RWA product; its provider owns the implementation.

| Endpoint                 | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| `GET /v1/earn/discovery` | List validated strategies and execution capabilities. |
| `GET /v1/earn/positions` | Read holdings and optional complete-scope totals.     |
| `POST /v1/earn/deposit`  | Prepare a strategy deposit from a wallet.             |
| `POST /v1/earn/withdraw` | Prepare an exit from an existing position.            |

Preparation stores a durable operation with reviewable terms and unsigned
transaction bytes or a next action. It never starts wallet signing or broadcasts.
API clients need an SDP API key and any compatible Solana wallet. Prepare with
`source: { ownerAddress }`, sign the returned transaction through your wallet
integration, then send base64 `signedTransaction` with its `actionId` and
`version` to `POST /v1/operations/{operationId}/submit`. No SDP wallet record or
provider connection is required. The prepared owner and every other required
signer must sign the unchanged message. `202` means accepted work; the worker
broadcasts and tracks those exact bytes. Submit never prepares another action.

An existing connected wallet's `source: { walletId }` is optional. Its `submit`
action takes `actionId` and `version` without signed bytes; the worker requests
signing through the configured provider. `awaiting_signature` covers pending
signing, and `sign_in_provider` supplies instructions such as "Sign in
Fireblocks". Wallet approval policies remain part of signing; Earn adds no
approval endpoint or separate approval status.

Withdrawal choices advertise `nextAction: select_option` and `terms.options`.
Refresh requires the current `actionId` and `version`, plus an advertised
`optionId` for selection. It returns a new review before submission. Later
refreshes retain the selected route rather than choosing another.
Refresh is preparation-only and unavailable after any submit acceptance.

Funding swaps and deposits share one atomic transaction. The deposit uses the
swap's guaranteed minimum output, leaving any excess in the wallet. Oversized
compositions retry a compact route, then refuse before persisting a build if
both legs still cannot fit. Fund the strategy's deposit token separately in
that case; SDP never returns a standalone funding swap or deposit continuation.

A source uses an `ownerAddress` or an optional connected `walletId`. That
identity selects signing authority; it does not select another Earn product or
execution model.
The movement ledger still records the signing source so wallet visibility and
position ownership remain explicit. Signed messages are immutable, and uncertain
outcomes resume their original attempt instead of creating another transaction.

Queued exits stay under the same operation. Request acceptance or share escrow
is not a payout. Provider and chain observations establish delivery without a
separate claim endpoint. Only `canCancel=true` permits preparation cancellation,
and the route still checks `earn.manage`. The capability is false after any
submit acceptance or while an exposed owner transaction outcome is unknown.
Pending signing and queued exits remain tracking-only after submit: neither
refresh nor cancellation can change an accepted operation. A definitive signing
rejection or proven nonexecution ends it as `failed`; only then may a new
deposit or withdrawal request use a new idempotency key. Unknown outcomes never
permit replacement. Internal provider cleanup for permission loss or expiry is
not an API cancellation feature.

The 53 former catalogue, program, product and transaction HTTP operations are
removed. Earn is prelaunch, so no historical-action adoption or compatibility
execution path is supported. Current operations use one async lifecycle.

Canonical database access uses `earn_wallet_transactions` and
`earn_wallet_withdrawal_request_transactions`. New builds use these physical
tables. A schema-only companion removes superseded build storage, split-swap
advisories, provider actions and provider wallets after the rewrite is serving.
No old builds are copied or resumed.

Earn follows the existing module release-channel publication rules. Read
`apps/sdp-docs/content/docs/earn/integration-details.mdx` for requests and recovery,
and `docs/architecture/earn-core-api-proposal.md` for the migration boundary.

## Rollout gating (pre-release)

Earn is a Markets sub-module, and the release channel decides both: Earn is
`beta`, so it runs on the `beta` and `experimental` channels and stays dark on
`stable`. API-side the hierarchy is owned by `isEarnEnabled`
(`apps/sdp-api/src/lib/feature-flags.ts`); web-side the `markets` and `earn`
flags in `apps/sdp-web/src/flags/definitions.ts` default on inside the channel
and gate the nested route segments (`dashboard/markets/layout.tsx`). Gating is
module visibility, not the provider on/off lever — see the ADR 0002 addendum.

## Code ownership

| Surface                                   | Source                                                           |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Strategy and operation contracts          | `packages/sdp-types/src/earn-core.ts`, `operations.ts`           |
| Provider catalogue contracts and registry | `packages/sdp-earn/src/types.ts`, `index.ts`                     |
| Provider transaction planning             | `packages/sdp-{kamino,veda,jupiter-lend,ondo,hastra,wisdomtree}` |
| Earn preparation and reads                | `apps/sdp-api/src/routes/earn/core`                              |
| Shared operation routes                   | `apps/sdp-api/src/routes/operations`                             |
| Async execution and recovery              | `apps/sdp-api/src/services/jobs/reconcile-operations.ts`         |
| Movement ledger and holdings              | `earn_movements`, `earn_positions`                               |
| Operation coordination                    | `operations`, `operation_attempts`                               |
| Provider withdrawal obligations           | `earn_vault_withdrawal_requests` and its actions                 |
| Dashboard client and polling              | `apps/sdp-web/src/lib/earn-client.ts`, `earn-core-data.ts`       |

`CLAUDE.md` describes provider capabilities and the execution invariants.

## Catalogue data: the sync cron and metrics refresh

Two live paths write `earn_strategies`, split by how fast the data they own
moves. The catalogue sync is the only path that can admit rows; the metrics
refresh is update-only.

### The metrics refresh — the fast half

`apps/sdp-api/src/cron/earn-metrics-refresh.ts`

- **What it does:** for every provider implementing the optional live-metrics
  capability (`supportsLiveMetrics`), pulls the whole shelf's current figures in
  one or two calls and rewrites `current_apy` plus volatile `risk_metadata`
  (TVL, holders) on rows the catalogue already holds.
- **When it runs:** every 5 minutes as the `refresh-earn-metrics` Cron
  Definition behind `isEarnEnabled`, once per environment (`scope: "cluster"`):
  each registration refreshes its own environment's shelf and guards its
  cluster's deposit mints. Unslotted: duplicates only rewrite the same figures. It logs its own `sdp_cron_run`, and that is the point: "the
  refresh silently stopped running" is this pass's worst failure (rates quietly
  go stale) and is invisible from the catalogue sync's run events.
- **What it cannot do**, and this is the whole safety argument:
  - **Insert.** The normal path uses one `updateStrategyMetricsBatch` per
    provider/environment and falls back to `updateStrategyMetrics` per row only
    to isolate malformed data. Both match existing catalogue identity and
    no-op otherwise, so a provider reporting figures for a vault the catalogue
    refused cannot admit it. Every admission gate stays in the hourly sync below.
  - **Change what a strategy IS.** Its input carries the rate and volatile
    metadata only; the metadata is MERGED, so `curator` survives.
- **Why not read live at request time:** `GET /v1/earn/discovery` reads exactly one
  source for the state it reports (ADR 0002, 2026-08-11 addendum), and an
  overlay would blend two. Freshness comes from cadence, so every consumer —
  API, dashboard, a partner's own cache — sees the same numbers.
- Opting in is a promise about cost as much as capability: a provider whose
  rates arrive on the same paged endpoint its catalogue uses should NOT
  implement it — the five-minute pass would re-pay the entire catalogue cost
  for the rate alone.

### The sync cron — the admitting path

`apps/sdp-api/src/cron/earn-catalogue-sync.ts`

- **What it does:** walks every client in `EARN_PROVIDER_CLIENTS`, calls
  `listStrategies` per environment (sandbox + production), validates each row
  against the provider's declared support, and upserts on
  `(provider, provider_reference, environment)`.
- **Non-production is TWO lanes since PRO-1742:** the provider's own catalogue
  for that environment (the fundable shelf), plus a browse-only MIRROR of the
  production pass's accepted mainnet shelf, written from the same fetch (the
  mirror never re-reads the provider). Mirrored rows derive `fundable: false`
  and every provider mutation refuses them; reads default to the environment's
  own cluster and only serve the mirror on an explicit `?cluster=` opt-in. A
  reference both sources list stays on the own (fundable) shelf: the mirror
  under-reports it, warned hourly (ADR 0002, PRO-1742 addendum: this caps a
  fully-faithful mirror to cluster-distinct, address-keyed references).
- **When it runs:** once per hourly Redis slot (scheduled `*/5 * * * *`, so a
  slot that a cron service boot claimed mid-hour is retaken five minutes after it
  expires) and once when the cron service starts, as
  the `sync-earn-catalogue` Cron Definition behind `isEarnEnabled`
  (`apps/sdp-api/src/cron/earn-catalogue-sync.ts`, ADR 0011). Every run claims
  an hourly Redis slot first (`runEarnCatalogueSyncIfDue`), so a boot run and
  the scheduled run never both sync in one window. Completely inert in a
  flag-off environment.
- **Failure behaviour:** per-provider isolation. `NOT_IMPLEMENTED` and
  `PROVIDER_NOT_CONFIGURED` are info-level skips (that is the normal state for
  the stub providers); any other error is logged for that provider and never
  sinks the others.
- **Adding a provider needs no cron change** — it is registry-driven.
- **To change cadence:** edit the definition's `schedule`.
- **An operator stop outranks the sync.** The upsert never overwrites a
  `paused`/`deprecated` status, so an emergency pause holds until someone writes
  the status back to `active` — a sync pass can no longer resurrect it. Metadata
  and rates keep converging while the row is closed.

- **Delist convergence:** after a successful non-empty provider response, active
  rows absent from that provider's live catalogue become deprecated metadata
  tombstones, scoped to the cluster sub-shelf the responding lane is the truth
  for. They disappear from browse and deposit admission while the stable
  strategy id keeps resolving to its vault and mint identity. A provider
  relist reactivates only a sync-owned tombstone; operator-paused or deprecated
  rows remain sticky. The mirror lane additionally converges to EMPTY on a
  reliable "nothing is listed" answer (an empty accepted mainnet shelf, or a
  steady-state production skip), so orphaned mirror rows never outlive their
  truth source;
  fundable own shelves keep the absolute empty-keep-set refusal.

### Figure anomaly check (`services/earn/catalogue-anomaly.ts`)

Both passes take provider-reported APY and TVL at face value; this is the
one check between a provider's number and the comparison table (PRO-1867,
threat model EARN-010).

- **What it does:** before either pass writes, it reads the stored figures for
  the (provider, environment) it is about to write (`listStrategyFigures`,
  the sync scoped to its lane's cluster sub-shelf) and diffs the incoming
  figures against them. Every APY or TVL move past a bound, or an APY above
  the absolute ceiling, is one `sdp_api_earn_catalogue_figure_anomaly` warn
  event; a lane that held rows and reliably received an empty catalogue is
  one `sdp_api_earn_catalogue_shelf_disappeared` error event, whether or not
  the lane then delists. New rows are exempt from the diff, never from the
  ceiling. A missing or unparseable figure on either side is skipped, not
  guessed.
- **What it never does:** block or alter a write. The write paths' own
  invariants (update-only refresh, gated admission, the empty-keep-set
  refusal) are untouched, and a failure reading the stored figures costs the
  pass its diff, not its write.
- **Bounds** live in `EARN_FIGURE_BOUNDS` (3x ratio with an absolute floor
  for both metrics, 100% APY ceiling) and are starting points, pinned by a
  test so a change is a deliberate diff. The Grafana rules
  (`sdp-infra/kora/alert-rules/sdp-earn-catalogue-*.json`) key on the event
  names, not the numbers.

## Invariants (do not break)

1. **Money out beats money off.** Money-in gates on environment, strategy,
   surfacing, entitlement, and provider capability/configuration. Exit and
   existing-position reads omit the money-in gates; history reads take no
   provider gate. Disabling a provider must never trap funds or hide history.
2. **Fail closed on drift.** Provider ids from the DB are open strings; all
   dispatch goes through `resolveEarnProviderClient`, which throws on unknown
   ids rather than guessing.
3. **Reads never gate on availability.** The catalogue and program snapshots
   stay readable while a provider is disabled.
4. **Declared support bounds the catalogue.** A synced strategy outside the
   provider's declared token/source envelope is rejected and logged, not
   persisted.
5. **Solana-only customer rails.** No other chain's addresses or transaction
   identifiers may leak into wire types or UI. Yield-source host chain remains
   provider metadata, and the API owns product visibility independently from
   the sync's complete persisted inventory.

## Adding a provider (the 30-second version)

The compiler and tests enforce most of this; the
[playbook](../../docs/contributing/earn-pluggability-playbook.md) has the full
walk:

1. Add the id to `EARN_PROVIDERS` (`@sdp/types/provider-access`) — every
   `satisfies Record<EarnProviderId, …>` now errors until you finish.
2. Subclass `StubEarnClient` in `providers/<id>/client.ts`; register it in
   `EARN_PROVIDER_CLIENTS`; add the package.json subpath export (a
   registry-consistency test fails if you forget).
3. Choose availability explicitly. A credentialed provider adds its key pair
   to `env.d.ts`, `turbo.json`, `scripts/secret-keys.mjs`, and managed secret
   projection. A public/on-chain provider joins the deliberate keyless set and
   adds no placeholder secret.
4. Implement `listStrategies` first, then only the capabilities needed by
   current strategy actions. Catalogue sync picks it up through the registry.
   Do not restore program or automated-allocation contracts.
5. Tests are no-network by design: stub `fetch` per the canonical pattern in
   `src/fetch.test.ts`.
6. If SDP executes for the provider (vault-direct): the executing client in
   its own package (`packages/sdp-<id>`), the per-cluster deployment registry
   in `@sdp/types`, both API registry entries, and the three Kora sponsorship
   allowlists. Also test owner-paid and caller-provided `feePayer` builds, and
   publish every quote the provider requires in OpenAPI (playbook §4d).

Curators and vaults are catalogue data. New closed category values require one
shared type-registry update; see the playbook for each exact change shape.

## Testing

```bash
pnpm --filter @sdp/earn test        # node:test, no network (fetch stubbed)
pnpm --filter @sdp/earn typecheck
```

API-layer earn tests (routes, repository, availability) live in
`apps/sdp-api` and run under vitest + testcontainers. Canonical web route files
live in `apps/sdp-web/src/app/(session)/dashboard/markets/embedded-yield`; shared internal
module tests remain in `apps/sdp-web/src/app/(session)/dashboard/markets/earn`.
