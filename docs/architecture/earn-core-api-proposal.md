# Earn core API

Status: implementation under review, 18 November 2026. **Critical**: this
changes fund movement, signing authorization and recovery. The contract follows
the existing module tags and release-channel rules.

Earn aggregates provider strategies through discovery, positions, deposits and
withdrawals. Treasury and Embedded Yield use the same contract. Providers supply the underlying products;
SDP supplies discovery, wallet integration, execution tracking and recovery.

## Contract

| Operation                                   | Purpose                                                             |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `GET /v1/earn/discovery`                    | Filter the strategy catalogue and its rates/capabilities.           |
| `GET /v1/earn/positions`                    | Read tracked or explicitly discovered holdings and optional totals. |
| `GET /v1/earn/positions/{positionId}`       | Read one visible position with the same live valuation rules.       |
| `POST /v1/earn/deposit`                     | Prepare a deposit using a strategy, source and token amount.        |
| `POST /v1/earn/withdraw`                    | Prepare an exit using a position and explicit quantity.             |
| `GET /v1/operations`                        | List scoped activity and outstanding actions.                       |
| `GET /v1/operations/{operationId}`          | Read terms, next action and settlement observations.                |
| `POST /v1/operations/{operationId}/submit`  | Authorize and queue the exact reviewed transaction.                 |
| `POST /v1/operations/{operationId}/refresh` | Select a route or safely replace terms before submit acceptance.    |
| `POST /v1/operations/{operationId}/cancel`  | Abandon preparation only while `canCancel` permits it.              |

Six independent WisdomTree onboarding operations remain for customer
verification, documents, corrections and wallet registration. They are
eligibility requirements, not another deposit or withdrawal API. The resulting
surface has **16 method/path pairs: eleven under Earn and five shared operations**.
No obsolete Earn URLs, redirects or retirement stubs remain.

## Vocabulary

A **strategy** is a catalogue item, whether a vault, lending market or RWA.
`strategyId` identifies the SDP record; `providerReference` identifies the
provider instrument. A **position** is a wallet's holding. An **operation** is
one durable deposit or withdrawal intent; an **attempt** is one immutable
signing and submission attempt within that operation.

API clients normally supply an SDP API key and `source: { ownerAddress }`, using
any compatible Solana wallet. Preparation returns an unsigned transaction; the
caller signs its unchanged message with the prepared owner and submits base64
`signedTransaction`. No SDP wallet record or provider connection is required.
An SDP custody wallet's `source: { walletId }` is optional and uses its
configured signing policy. Neither source creates another API family or
synchronous execution path. Provider adapters can retain exact protocol terms
such as vault, reserve and redemption order.

New database references use `strategy_id` and `strategy_reference`. Canonical
wallet transaction tables store new operation builds with tenant-enforced RLS.
They do not import old builds or mirror writes. A schema-only companion removes
the two superseded build tables, split-swap advisories, provider actions and
provider wallets after the rewrite is serving. Strategy columns retain
synchronized aliases where current ledger writers still use them.

## Verified baseline

Source: `main` at `c4c5467ece29707b8b3fbda1e6570a5dbd254d00`. Counts exclude
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
published none. The replacement uses the same publication rules for its five
core endpoints and five shared operation routes. Public OpenAPI, reference,
playground, Postman and AI resources follow the existing module tags and release
channel; there is no rewrite-specific visibility override.

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
   terms, an `actionId`, a version and `nextAction`. For `ownerAddress`, this
   includes the unsigned transaction. Preparation never signs or broadcasts.
3. Review the estimate, enforceable minimum and known fees. The caller signs the
   exact returned transaction with the prepared owner and submits its signed
   bytes. Submit returns `202` after durable acceptance and never prepares
   another action. An optional SDP custody wallet instead authorizes the worker
   to request signing through its configured provider.
4. The worker broadcasts and tracks the same transaction. Poll the operation
   through submission and settlement. A queued exit stays `submitted` until its
   request is verified, then becomes `settling` while payout is pending. Delayed
   settlement needs no separate claim endpoint. Once submit is accepted, refresh and cancellation are unavailable.

Configured-wallet signing uses `awaiting_signature`. When a person must act in
the wallet provider, `nextAction: sign_in_provider` supplies instructions such
as "Sign in Fireblocks". Provider approval policies are part of signing; Earn
exposes no separate approval endpoint or status. The worker observes signing
and proceeds without another submit call.

Withdrawal route choice advertises `nextAction: select_option` and
`terms.options`. Refresh takes the current `actionId`, `version` and selected
`optionId`, then returns a new transaction review. Later refreshes retain the
selected route and fail if it is unavailable. Submit accepts no route option.
Refresh only prepares unsigned bytes and terms before the first submit
acceptance. It never signs, broadcasts or revokes an earlier transaction.
After acceptance, refresh and cancel return `409 CONFLICT`; only track the
operation's outcome. A definitive signing rejection or proven nonexecution is
terminal `failed`. Retrying then creates a new deposit or withdrawal with a new
idempotency key. An unknown outcome never authorizes replacement.

`canCancel` is the server's state capability, independent of route permission.
It is false after any accepted submit and while an
exposed owner transaction has an unknown outcome. Call cancel only when it is
true and the caller has `earn.manage`. Pending provider signing and queued
withdrawals have no public cancellation flow after submit. Internal permission
or expiry cleanup remains private worker safety.

Swap-funded deposits combine the swap and deposit instructions in one unsigned
transaction. The deposit uses the swap's guaranteed minimum output. A compact
route retry may reduce transaction size; if both legs still cannot fit,
preparation refuses before persisting a build. The caller must fund the
strategy's deposit token separately. There is no standalone funding swap or
deposit continuation.

Every mutation uses a persisted `Idempotency-Key`. An uncertain HTTP response
retries the same request and exact signed bytes. Queue acceptance, share escrow,
signing and chain inclusion do not establish economic payout.

### Recover expired solver escrow

A new `/v1/earn/withdraw` for a tracked position and `amount.kind="all"` can
offer **Recover expired escrowed shares**, even when its wallet holds no free
shares. The caller explicitly selects that option through `/refresh`, reviews
the new action and follows the normal signing and `/submit` flow. It uses
`earn.execute` and the inherited source's current wallet grants. The original
accepted operation is not reopened; its `/cancel` remains unavailable.

Scoped, ordered queries inspect at most three candidates for the position and
select the first recoverable live escrow. Closed or no-longer-expired candidates
are skipped. After three stale candidates, one database lookahead returns no
recovery if history is exhausted, or defers the recovery option if more remain.
Other available withdrawal routes remain usable; preparation returns retryable
`503 SERVICE_UNAVAILABLE` only if no route survives. Actual proof or provider
failures still fail closed.

Live provider proof must match its tenant/source, mints, nonce, creation time,
deadline and share quantity. The private builder and simulation recheck that
the expired escrow can return those shares. A different or closed request is
not proof that a replacement may execute.

The new operation references its exact cancellation action. Completion requires
that action to finalize, its canonical build to be consumed by that attempt,
and the request's `cancel_signature` and `closing_signature` to match it.
Authenticated lifecycle evidence must prove the share return.
`settlementOutcome="recovered"` reports the share mint and quantity, not the
original requested asset payout. Exact already-broadcast canonical bytes can be
recorded atomically without reopening the terminal request. Unknown outcomes
remain unresolved.

### Release the current Hastra redemption

A tracked Hastra position with a known pending operator redemption can offer
`release_current_redemption` through the same withdrawal flow. It requires an
explicit choice even when it is the only option. The caller reviews consent to
release whichever owner redemption is current when the transaction executes,
including a replacement created after preparation. The instruction has no
amount or cycle argument, so a preparation-time check cannot narrow that scope.

The bounded lookup stays within the position's project and uses its latest
recorded pending request to locate the provider account. The new canonical
cancellation build has `mechanism="operator_redemption"`,
`withdrawal_request_id=NULL` and `operation_only=true`. It belongs to the new
operation attempt, not the historical request. No financial request/action row
is created. Acceptance freezes earlier matching Hastra requests' financial
reconciliation while the outcome is uncertain. Finalized release retains that
freeze permanently, so a replacement with the same amount cannot become a
fictional payout for an earlier request. A definitive no-effect failure lifts
the freeze. A release that never lands is one: once its blockhash expires at
finalized commitment, SDP never resends it. A second finalized-history miss at
least 30 seconds after the first fails it `TRANSACTION_EXPIRED` only when every
RPC endpoint, with at least two distinct endpoints answering at a finalized
slot past the expiry, also misses it. One endpoint alone keeps the outcome
pending. The historical financial record stays unchanged. Its operation ends
`failed` with `REDEMPTION_SUPERSEDED` and no settled amount or settlement outcome;
that ends tracking, not proof of nonexecution or a historical payout. Covered
requests and actions leave background polling. Only the new release completes;
never automatically retry the superseded withdrawal.

The guard matches organization, project, environment, position, owner, custody
source, provider, PDA and mints. Local causal row ordering identifies earlier
records for this bookkeeping boundary; it does not prove an onchain request
cycle or a cancelled amount.

The release closes the current request and revokes Hastra's burn delegation
if still present, preserving unrelated delegates. It moves no tokens, mints no
PRIME and pays no USDC. Completion requires the release attempt's
own finalized cancellation transaction and authenticated provider evidence.
Its result is `settlementOutcome="recovered"` with `settledAmount=null`, with
no payout movement. A PDA-scoped reservation excludes other SDP release or
redemption attempts while execution is unresolved. It does not stop the owner
or provider from replacing the onchain request, which the reviewed scope
explicitly permits. Issuer freezes can still prevent release.

If this exact transaction finalized successfully but its provider events stay
unreadable, an operator can use the [audited recovery tool](../ops/earn-redemption-release-recovery.md).
It requires independent release evidence and an explicit attestation, verifies
the accepted signature's finalized receipt, and commits the evidence,
completion and cooldown atomically with the audit record. It creates no token
amount or financial payout. Ordinary automatic verification is unchanged.

Source authorization, exact-byte signing, idempotency, retries and post-submit
cancel/refresh barriers stay unchanged. A different signature, a missing
provider account or a completed historical cycle cannot complete this release.
Unknown outcomes keep the reservation and remain unresolved.

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
- Actions and signed bytes are immutable. An old version cannot authorize a
  replacement. Every worker restores the recorded principal and checks current
  permission, wallet binding and credential status.
- Earn passes `requiredAction: "earn.execute"` at every new signing, proposal,
  sponsor and broadcast boundary. Fresh API-key grants and member role/project
  access must still permit that action. Refusal restricts the attempt to
  observation and cleanup; shared admission's default exit behavior is unchanged.
- A durable provider binding precedes its single create. Workers use fenced
  180-second leases with a 120-second action budget. A timeout retains the same
  attempt and its uncertainty; it never authorizes another proposal.
- Signed or ambiguously dispatched attempts remain unresolved until proven.
  Blockhash expiry and missing RPC history alone do not prove nonexecution.
  An exposed owner transaction may have been broadcast independently.
- Refresh always names the current action ID/version and is limited to safe
  preparation before any submit acceptance. It selects an advertised option or
  replaces unsigned terms only when safe. New terms require explicit submission.
  Post-acceptance refusal or proven nonexecution is terminal failure; unknown
  outcomes retain `wait` and the original attempt.
- Cancellation is limited to safe preparation before any submit acceptance.
  Its check serializes against submission and survives later refreshes.
  Internal cleanup never gives a caller post-submission cancellation authority.
  Observation-only attempts can never regain broadcast authority.
- Deposit acceptance atomically commits signed bytes, execution acceptance and
  its critical audit intent. Exit auditing retains its best-effort posture.
- An exposure-cap refusal restricts signed deposits to observation and reports
  `DEPOSIT_REFUSED`, final only after proven nonexecution. Already observed
  deposits reach the ledger even when current caps or exposure reads refuse
  new deposits.
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

A position detail resolves one visible stored ID or discovered selector, then
uses the list's hydration and projection. It never scans the full catalogue or
imports a holding. Stored IDs use the same activated-position and signed-ledger
visibility as the list. Discovered selectors verify their source before one
targeted provider read. Unknown live values remain unavailable; only a proven
empty discovered holding is `404`. A provider read failure is `503` for a
selector whose holding cannot yet be verified.

By default the activity feed polls active work and the newest 50 history
entries. Older pages load only on request. Expanded history keeps its snapshot
and cursor while active work stays live; Refresh returns to the newest page. A pending row that leaves the active query stays
mounted until shared observation sees completion, including when it is older
than the current history page. Recent and foreground work shares one bounded
100-ID request each second per dashboard cache. Provider waits retain the
15-second feed cadence. Direct movement or queued request projections use two
bulk DB reads per page (three for a mixed page), instead of two per row.
Specialized release/recovery projections retain their proof checks under bounded
concurrency. These counts exclude authorization and list queries and add no
Solana RPC calls. The active filter uses a partial project-scoped index.

Completion refreshes the affected position and funding wallet together at the
acknowledged slot. A failed or unavailable read preserves the previous pair.
Each position retains its strongest authorized movement proof instead of every
completed movement in the session. A full exit returns its persisted closure on
that first refresh, including when the transaction observer skipped closure.

Withdrawal planning quotes each route once and reuses its protection floor.
Token-sized exits add one cold share-mint precision read, zero warm reads;
concurrent precision reads share work and failures are not cached. Required
simulation remains before returning unsigned bytes.

Solver recovery adds zero provider reads without an eligible recorded candidate
and one on the usual path. Worst-case proof reads fall from unbounded to three:
it skips stale candidates in this position's creation order and stops at the
first proven recovery. After three stale reads, one database lookahead detects
remaining candidates without another provider call. If any remain, omit the
recovery option while preserving other available routes; return retryable
`503 SERVICE_UNAVAILABLE` only if no route survives. Selecting recovery reuses
that call's validated proof during build admission, avoiding a duplicate read
before the provider builder's existing validation and simulation.
That proof is never persisted or accepted from a caller; later preparation or
refresh reads provider state again. Each review offers at most one recovery
option and never scans another position or fans out provider reads.
Hastra release also adds no request read without a known pending candidate and
one live request read when present. It targets the current owner request, not a
historical cycle. No provider account is fetched twice in one choice read.

Operation recovery uses the partial index on environment, `next_check_at` and
ID. Four competing consumers per environment claim only work ready to start;
one slow signer cannot block free consumers. A dedicated PostgreSQL listener
wakes consumers after commit, on startup and after reconnection. Hints contain
only the environment, never execution authority. A two-second recovery wake
covers missed notifications. Error-free operations in SDP's execution pipeline
recheck every two seconds for the first two minutes after acceptance. Older
pending states back off from 15 seconds to five minutes; `sign_in_provider`
waits cap at one minute.
Status progress resets the delay to 15 seconds. Terminal operations are
excluded from due scans.

The same listener wakes an observation-only lane for direct movement and queued
action signatures. Each pass claims up to 64 rows of each kind with expiring,
fenced PostgreSQL claims, then makes one batched status request. At most two
passes and four reducers per pass run per environment and replica. Direct and
queued work share the processing budget fairly. Recent pending transactions
retry after 250 ms, older work after 30 seconds and failed reads after five
seconds. Obsolete queued hints retire in bounded indexed pages without changing
financial history. Fast observation never signs, broadcasts or treats missing
evidence as failure. Both paths use the same financial reducers; queued escrow
is not payout and missing amounts stay unknown.

The minute recovery sweep reads one available snapshot, up to 256 movements or
128 queued actions, without reserving it. Each batch needs one status request,
one finalized-height read only when needed, and one shared absence-proof read
per endpoint only for expired signatures. It then takes fresh claims for four
rows at a time, leaving later rows available to the fast observer while provider
reads wait. Both lanes share the same fenced claims.

Evidence lives only in that invocation and is matched to the claimed row's exact
signature, signed bytes, expiry and tenant. Changed state or absence markers
disable the earlier negative evidence. Provider and finalized receipt proofs
still run live. Recovery can rebroadcast only recorded bytes and retains the
existing conservative expiry rules. Recovery preserves main's single status
batch while processing four rows concurrently instead of serially. It adds no
persistent cache or extra queue. Concurrent observers may overlap a read before
either claims a row; financial transitions still use the canonical guarded
writers.

Within a short observation window and exact organization/project/environment/principal,
concurrent signature observations share a lazy RPC client and batch at most
256 signatures. Four simultaneous same-authority status requests become one;
two confirmed-height reads during custody proposal handling become one. There
is no cross-principal sharing or long-lived height cache. Failed height reads and
completed signature batches are evicted; missing signatures never become
durable evidence of nonexecution. Domain-settlement projections read their
ledger before constructing a transaction or making execution RPC calls.

Successful atomic deposit preparation keeps its existing RPC budget: one
maximum-compute probe and one final simulation. Size overflow allows one compact
retry. Removing the split path removes one baseline token-balance read and two
standalone-swap simulations from an oversized preparation. No follow-up
swap-status polling or second deposit preparation is needed.

## Reconciliation responsibilities

Previously, submission saved accepted work for the next 15-second operation
tick. Background movement observation ran every minute; a detail read could
observe sooner. These scheduling delays made Earn feel slow even after the
chain had progressed. The new workers wake after commit, and the fast observer
writes that progress to the financial ledger between minute ticks. This changes
when SDP looks for evidence, not the evidence required for completion.

Accepted work is durable before workers wake. The operation worker executes it;
the fast observer records chain progress; the dashboard reads that durable
progress. Scheduled recovery handles missed wakeups and unresolved obligations.

| Component                  | Cadence                                             | Responsibility                                                                                                                                   |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Operation workers          | Commit hint, startup/reconnect, two-second fallback | Advance accepted work through authorization, signing and broadcast. Four consumers per environment claim only work ready to start.               |
| Fast transaction observer  | Same wakeups; recent work due again after 250 ms    | Batch direct and queued-action signatures and record observed progress. Never sign, send or infer expiry.                                        |
| Movement recovery          | Every minute                                        | Observe unresolved signed transactions, retry identical bytes and apply proven expiry. Claims four rows at a time after shared chain reads.      |
| Queued withdrawal recovery | Alongside movement recovery                         | Track request/cancel transactions and provider fulfillment. Pending requests back off toward known maturity; escrow is never reported as payout. |
| Provider-order settlement  | Alongside movement recovery                         | Verify provider delivery and finalized destination evidence independently of the source transaction.                                             |
| Payout and receipt repair  | After the movement pass                             | Fill missing withdrawal amounts or deposit receipts from finalized evidence. Never invent a value.                                               |
| Abandoned-build cleanup    | Within queued recovery                              | Release expired unsigned-build reservations after finalized-height proof; retain recovery metadata.                                              |
| Catalogue sync             | Startup, then roughly hourly                        | Discover and validate strategy identity and availability.                                                                                        |
| Metrics refresh            | Every five minutes                                  | Refresh rates, TVL and risk figures for admitted strategies.                                                                                     |

Shared custody support remains separate: Fireblocks proposal observation runs
every 30 seconds, custody-policy checks every minute, and sponsorship-budget
reconciliation every minute. These observe provider outcomes and reconcile
existing reservations; they are not additional Earn execution queues.

The dashboard shares one active-operation request per second, capped at 100 IDs,
then backs off as work ages. Completion refreshes the affected position and
wallet together with the movement's read floor. Detail reads retain a bounded
observation-only chain read-through. Neither UI polling nor a lost notification
is required for recovery, and stopping new Earn admission does not stop existing
money obligations from completing.

## Local latency evidence (PRO-2578)

These checks cover scheduling, request budgets and balance freshness on top of
main `c65066528`. They do not measure live signing, provider settlement or a
signed-in browser. The local PostgreSQL and Redis instances are disposable;
chain and provider responses are simulated.

- Operation pickup: 16 accepted operations reached their fenced worker claim
  in 28.40 ms median and 34.49 ms p95/max. The controlled-clock comparison
  places acceptance just after a tick: 14,999 ms previously, zero timer delay
  with notifications, and 1,999 ms with a lost notification.
- UI budget: with 500 pending activity rows mounted, the foreground completion
  reaches the cache within one second using one status request. Passive rows add
  no individual timers. A 350-row disappearing backlog drains in four requests
  capped at 100 IDs each.
- Projection budget: 50 direct operations or 50 queued requests need two DB
  reads instead of 100, with equivalent results. A mixed page needs three.
  Validating 100 balance proofs also drops from 100 serial DB reads to one;
  signature observation remains one shared RPC read.
- Refresh budget: affected positions and wallets refresh together; 120
  successive actions keep at most two movement proofs in each detail request
  and one retained proof in the next portfolio read.
  In the two-wallet fixture, refreshing one affected wallet drops from three
  HTTP requests (inventory and both balances) to one balance request.
- Recovery backlog: 256 movements or 128 queued actions use one status request
  per batch. Twelve expired rows spanning three processing groups share one
  finalized height and one corroborating status read per endpoint per sweep.
  Repeating the movement sweep reads again; evidence does not survive between
  invocations.
- Backlog isolation: no rows are leased while the shared RPC waits. With four
  provider reads blocked, the fast observer still advances later work and a
  newly submitted movement or queued action. Competing workers take disjoint
  four-row claims. Changed absence markers or signed bytes cannot reuse earlier
  recovery evidence.

The competing-observer burst processes 129 finalized movements with three
status reads. It took 70 ms locally and 201 ms during a concurrent test run;
these mocked-chain results establish bounded draining, not a production SLA.

Provider approval and asynchronous redemption waits remain explicit operation
states. Live Treasury/Embedded Yield timings, preparation/initial-loading
profiles and deployment-scale load measurements remain PRO-2578 acceptance
work; these local results do not close that ticket.

## Rollout and remaining gates

The rewrite creates canonical wallet transaction tables directly, with no
legacy-table copies or intermediate alterations. Five migrations replace the
previous twelve added by this PR.

The schema-only companion then removes five obsolete tables and the retired
provider-wallet position link. It deliberately discards old prelaunch provider
positions and movements. Deploy the rewrite first: production and beta require
the cleanup parent, or a descendant, to be serving before applying the breaking
migration. Recovery after removal is a forward fix. No production database is
changed by preparing these PRs. Do not restore HTTP aliases or historical
execution paths.

Parent migration `0240` retains the existing Hastra address index while the
previous revision can serve. The schema-only companion removes it only after
this guarded parent is serving. Its pending migration must sort after every
parent migration. Reusing a released Hastra address requires that cleanup. The
global PDA lock and durable lease remain the concurrency authority.
Index retirement assigns no financial outcome to historical requests.

See the [threat model](https://www.notion.so/422d36dad52d81e2bcf2cbd62c8e4622) and
[integration guide](../../apps/sdp-docs/content/docs/earn/integration-details.mdx).
Provider sandbox execution, signed-in browser verification and security review
remain release gates. Local tests do not establish those external outcomes.
