# Earn core API

Status: implementation under review, 18 November 2026. **Critical**: this
changes fund movement, signing authorization and recovery. The replacement
contract remains internal pending named security sign-off.

Earn aggregates provider strategies behind four core actions. Treasury and
Embedded Yield use the same contract. Providers supply the underlying products;
SDP supplies discovery, wallet integration, execution tracking and recovery.

## Contract

| Operation                                   | Purpose                                                             |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `GET /v1/earn/discovery`                    | Filter the strategy catalogue and its rates/capabilities.           |
| `GET /v1/earn/positions`                    | Read tracked or explicitly discovered holdings and optional totals. |
| `POST /v1/earn/deposit`                     | Prepare a deposit using a strategy, source and token amount.        |
| `POST /v1/earn/withdraw`                    | Prepare an exit using a position and explicit quantity.             |
| `GET /v1/operations`                        | List scoped activity and outstanding actions.                       |
| `GET /v1/operations/{operationId}`          | Read terms, next action and settlement observations.                |
| `POST /v1/operations/{operationId}/execute` | Accept the exact reviewed action for async execution.               |
| `POST /v1/operations/{operationId}/refresh` | Prepare replacement terms only when safe.                           |
| `POST /v1/operations/{operationId}/cancel`  | Request cancellation and track its actual outcome.                  |

Six independent WisdomTree onboarding operations remain for customer
verification, documents, corrections and wallet registration. They are
eligibility requirements, not another deposit or withdrawal API. The resulting
surface has **15 method/path pairs: ten under Earn and five shared operations**.
No obsolete Earn URLs, redirects or retirement stubs remain.

## Vocabulary

A **strategy** is a catalogue item, whether a vault, lending market or RWA.
`strategyId` identifies the SDP record; `providerReference` identifies the
provider instrument. A **position** is a wallet's holding. An **operation** is
one durable deposit or withdrawal intent; an **attempt** is one immutable
transaction or approval action within that operation.

Sources use exactly one of `walletId` or `ownerAddress`. Signing follows the
wallet's configured policy or the owner's signature. Neither identity creates
a separate product, API family or synchronous execution path. Provider adapters
can retain exact protocol terms such as vault, reserve and redemption order.

New database references use `strategy_id` and `strategy_reference`. Canonical
wallet transaction tables store new operation builds with tenant-enforced RLS.
They do not import old builds or mirror writes. Old physical tables remain
untouched so the previous revision can serve during migration. Strategy columns
retain synchronized aliases where current ledger writers still use them.

## Verified baseline

Source: `main` at `841434f03c3742475380e9a1ad169a4c85d9ec18`. Counts exclude
middleware, automatic OPTIONS, dashboard proxies and cron routes.

| Former Earn family                                  | Method/path pairs | Replacement                                              |
| --------------------------------------------------- | ----------------: | -------------------------------------------------------- |
| Strategy list/detail                                |                 2 | Discovery with filters, including ID.                    |
| Shared movement feed                                |                 1 | Operation history.                                       |
| Custody vault actions, positions and reconciliation |                15 | Core actions, operations and position discovery.         |
| Shared deposit preview                              |                 1 | Terms returned by preparation.                           |
| Wallet transaction and holding routes               |                18 | The same core and operation contract.                    |
| Programs                                            |                 9 | Remove unsupported automation and program configuration. |
| Provider preparation/cancellation actions           |                 7 | Versioned operation steps and cancellation.              |
| WisdomTree onboarding                               |                 6 | Retain independent eligibility operations.               |
| **Total**                                           |            **59** | **Remove 53 old routes; retain six eligibility routes.** |

The baseline published 21 partner operations on beta/experimental. Stable
published none. The replacement restores the publication hold: no Earn or
operation route is promoted into public OpenAPI, reference, playground, Postman
or AI resources by this change. Runtime release-channel access remains separate.

## Previous flow

Wallet integrations listed strategies, requested a preview, calculated a floor,
requested a transaction build, collected signatures, called a direction-specific
submit route, then polled movement and withdrawal-request endpoints. Queued
withdrawals added separate options, previews, request builds and cancellation
build/submit routes.

Treasury used custody-specific vault endpoints whose handlers could sign and
submit during the request. Positions, movements and provider actions had their
own reads. Program routes exposed provider-managed allocation scaffolding, but
no registered provider implements that portfolio capability today.

Those HTTP wrappers duplicated client orchestration over shared provider
builders, `earn_positions` and `earn_movements`. Keeping them mounted would
retain two execution contracts. This rewrite removes the wrappers and updates
the dashboard and demo to the core contract.

## New flow

1. Discover a strategy and read positions using the selected source.
2. Prepare a deposit by strategy, source and token amount, or a withdrawal by
   position and quantity. Preparation records intent and returns reviewable
   terms, an `actionId`, a version and `nextAction`. It never signs or broadcasts.
3. Review the estimate, enforceable minimum and known fees. Address owners sign
   the exact returned transaction; registered wallets follow their custody
   policy. Execute accepts the reviewed identity and returns `202` after durable
   acceptance.
4. The worker signs, opens approval or submits through the existing signing and
   sponsorship waists. Poll the same operation through provider approval,
   submission and settlement. A later claim or on-chain cancellation requires
   another explicit review when advertised.

Every mutation uses a persisted `Idempotency-Key`. An uncertain HTTP response
retries the same request and exact signed bytes. Queue acceptance, share escrow,
provider approval and chain inclusion do not establish economic payout.

## Replacement boundary

Earn has not launched. This is a breaking replacement, with no compatibility
HTTP layer, historical-operation adoption, program migration or saved-intent
upgrade path. Removed product APIs and their unused implementation are deleted.
Only the core contract and its current consumers are supported.

Operations created through the new API retain their durable identity, exact
reviewed actions and recovery guarantees. Removing prelaunch compatibility does
not weaken the async lifecycle for new actions.

## Execution and recovery invariants

- Authorization checks named resources before idempotency. Deposit admission
  runs after replay and again at execution. Exits retain their weaker availability
  gate so disabling deposits cannot strand held funds.
- Actions and signed bytes are immutable. An old version cannot approve a
  replacement. Every worker restores the recorded principal and checks current
  permission, wallet binding and credential status.
- A durable provider binding precedes its single create. Workers use fenced
  180-second leases with a 120-second action budget. A timeout retains the same
  attempt and its uncertainty; it never authorizes another proposal.
- Signed or ambiguously dispatched attempts remain unresolved until proven.
  Blockhash expiry and missing RPC history alone do not prove nonexecution.
  An exposed owner transaction may have been broadcast independently.
- `refresh` advertises a fresh review only after definitive refusal or safe
  expiry. New terms require explicit execution. `wait` preserves an unresolved
  action.
- Cancellation is durable intent. Acknowledgment, on-chain queue closure and
  verified payout remain separate observations. Observation-only attempts can
  never regain broadcast authority.
- Deposit acceptance atomically commits signed bytes, execution acceptance and
  its critical audit intent. Exit auditing retains its best-effort posture.
- The movement ledger and provider requests remain the authority for settlement.
  Operation status does not manufacture settled amounts or acquisition history.

## Holdings, rates and RPC budget

Catalogue coverage and execution coverage are separate. Discovery returns
provider-reported APY and observation time; unknown values stay unknown.
Deposit admission is evaluated during preparation and execution.

Position discovery requires an explicit source. It reads supported integrated
strategies, reports unavailable reads and does not claim ecosystem completeness.
Discovered acquisition time and cost basis remain unknown. A balance is never
presented as profit merely because SDP lacks its purchase history.

Discovery makes one adapter call per provider/owner, currently at most four for
one source, instead of one per catalogue instrument. Underlying RPC counts depend
on the provider SDK and holdings. Tracked positions retain batched reads and
minimum-slot/finality checks. Identical summary requests can share in-flight
reads only after fresh access checks and within the exact tenant/source scope;
movement-triggered fresh reads cannot join stale work.

Withdrawal planning quotes each route once and reuses its protection floor.
Token-sized exits add one cold share-mint precision read, zero warm reads;
concurrent precision reads share work and failures are not cached. Required
simulation remains before returning unsigned bytes.

## Rollout and remaining gates

Migrations are additive because the previous revision serves during migration.
New wallet transaction tables start empty. Old physical objects remain unused
by the replacement; removing them requires a separate schema-only deployment.
Do not restore HTTP aliases or historical execution paths.

See the [threat model](../security/earn-core-api-threat-model.md) and
[internal contract guide](../../apps/sdp-docs/content/unpublished/earn/core-api.mdx).
Provider sandbox execution, signed-in browser verification and named publication
security sign-off remain release gates. Local tests do not establish those
external outcomes.
