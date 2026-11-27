# Earn routes

Earn is an aggregation API. Strategies are catalogue items; positions are
holdings; operations coordinate deposits and withdrawals. Treasury and Embedded
Yield consume the same contract. Do not add product-specific routes or restore
program creation, allocation configuration or automation.

## Route contract

`index.ts` mounts five core endpoints and six WisdomTree eligibility operations:

- `GET /discovery`: a filtered catalogue, rates and execution capabilities.
- `GET /positions`: selected holdings, discovery and optional complete-scope totals.
- `POST /deposit`: prepare by strategy, source and token amount.
- `POST /withdraw`: prepare by position and explicit quantity.
- `/onboarding/wisdomtree`: independent KYC/KYB, documents, corrections and wallet
  registration. Onboarding approval does not authorize a deposit.

Shared `/v1/operations` supplies list, detail, submit, refresh and cancellation.
There are no other Earn catalogue, preview, build, submit, movement or program
HTTP wrappers. Only current operation history and async recovery belong in operations.
Protocol-specific builders and ledger repositories remain shared domain code.

Every route declares an action. Reads use `earn.read`; preparation and execution
use `earn.execute`; safe preparation cancellation uses `earn.manage`.

### Public OpenAPI promotion

Earn and shared operations follow the same module release channel as the
runtime. The public contract contains five core endpoints and five operation
routes; provider eligibility stays internal. Keep the explicit public inventory
in `openapi/spec.test.ts` aligned with the router and normal publication rules.
Do not add rewrite-specific flags or preview visibility exceptions.

Update OpenAPI descriptions, authored guides and dashboard clients together.
Regenerate OpenAPI, route actions, served paths, playground, API reference,
Postman, AI resources and module map using their owning generators. Generated
files must not be edited manually. The consumer integration guide lives at
`apps/sdp-docs/content/docs/earn/integration-details.mdx`.

## Preparation and authority

`core/prepare.ts` resolves source ownership and the position's authoritative
strategy before idempotency. API clients normally have an SDP API key and use
`source: { ownerAddress }` with any compatible Solana wallet. This path requires
no SDP wallet record or provider connection. Return the unsigned transaction,
then accept its base64 `signedTransaction` through `/submit`. Verify every
required signature against the prepared owner and unchanged message.

`source: { walletId }` is an optional convenience for an existing connected
wallet; it delegates signing to that wallet's configured provider. Sources
contain exactly one identity. Never infer source authority from a provider
reference, replace it during withdrawal, or accept a caller-selected payout
destination.

Follow `validate → authorize → idempotent`. Every mutation requires a key.
Authorization checks resource access, not mutable execution state. Deposit
admission follows replay. A replay cannot skip fresh credential and wallet
binding checks. Wallet bindings come from authentication, not an independent
route read.

Preparation records immutable intent and a versioned action, and returns `202`.
It quotes, derives protection floors and simulates without signing, opening a
custody proposal or broadcasting. Token quantities carry a mint and decimal
string; withdrawal quantities explicitly name all, shares, token or intermediate.
Keep live balance/precision/minimum checks in domain services, not only the UI.

Each prepared version retains its identity. An accepted attempt and its signed
bytes stay immutable until a definitive outcome is known; it cannot be refreshed.

Swap-funded deposits return one atomic swap-and-deposit transaction. Retry an
oversized composition once with a compact route; refuse if both legs still
cannot fit. Never return a standalone funding swap or a deposit continuation.

`nextAction: select_option` advertises withdrawal choices in `terms.options`.
`POST /v1/operations/{operationId}/refresh` requires the current `actionId` and
`version`, plus `optionId` only for that selection. It prepares a new review
without authorizing execution. Later refreshes retain the selected route and
fail if it is unavailable.
Refresh is preparation-only: reject it after any accepted submit in the
operation's history. Pre-submit replacement still requires proof it is safe;
an exposed owner transaction with unknown outcome cannot be refreshed.

## Execution and async recovery

The cron service schedules operation workers and financial reconciliation.

`POST /v1/operations/{operationId}/submit` authorizes and durably queues the exact
reviewed transaction using `actionId`, `version` and required signed bytes. It
never selects a route or prepares another transaction. `nextAction: submit`
asks the caller to authorize the configured wallet's worker signing path.
The worker handles configured signing, provider proposals and broadcast,
including fast signers. No status read performs money work. A provider URL is a
signing instruction, not proof of a signature or settlement.

Use `awaiting_signature` while configured-wallet signing is pending and
`sign_in_provider` when the caller must act there. A provider's own proposal
and approval policy remain custody internals. Do not add an Earn approval
endpoint, status or second submit call to acknowledge provider-side signing.

Use existing signing and sponsorship waists, `createOrgSignerForCustodyWallet`
and `createSponsorshipFeePayment`, with the movement from `MOVEMENTS`. Every
worker reconstructs the original action principal and rechecks its current
credential, action grant, wallet binding and admission before a new effect.
Revocation does not become permission merely because an operation is queued.
Pass `requiredAction: "earn.execute"` at each new sign, proposal, sponsor and
broadcast boundary, including exits. Re-read API-key grants and member role and
project access there. Refusal permits only observation of known bytes and
provider cleanup. Keep the shared admission layer's default exit semantics.

Before deposit broadcast, recheck `EarnDepositEligibilityProvider` against the
stored provider, owner and instrument, including after delayed custody approval.
A refusal durably restricts the attempt to observation and retains
`DEPOSIT_REFUSED`; a provider outage retries without sending. Never run this
check during pending approval polling, withdrawals or settlement observation.

A durable provider account/proposal identity precedes the single create.
Fenced leases prevent takeover from racing a possibly active worker. The lease
is 180 seconds; the action budget is 120 seconds. Reserve time at each external
boundary. An uncertain timeout never permits a second create.

Owner-signed submissions verify every required signature and the complete
prepared message. Deposit acceptance atomically commits exact signed bytes,
execution acceptance and its critical audit intent. Audit failure cannot leave
a sendable deposit. Exit auditing retains its best-effort posture.

Retry an uncertain submission with its exact signed body and original identity.
Blockhash expiry, a timeout or missing RPC history alone does not prove
nonexecution. Exposed owner transactions may have been broadcast independently.
After submit acceptance, only track the outcome. Refresh and cancellation must
return `409 CONFLICT`. A definite signing rejection or proven nonexecution is
terminal `failed`, with no refresh action. Retrying after that known failure
uses a new deposit/withdrawal request and idempotency key. Unknown outcomes
retain `wait` and the same attempt. Refresh never signs, broadcasts or revokes
prior signed bytes.

Expose `canCancel` from durable operation state and history. It is a state
capability, not a permission grant. The public route checks `earn.manage` and
permits cancellation only before any submit has been accepted, with no exposed
owner transaction outcome unknown. Serialize that barrier against submission
and retain it across action versions. Pending provider signing and queued
withdrawals have no public refresh or cancellation path after submit.

Permission/expiry cleanup remains an internal worker safety mechanism.
Observation-only attempts never regain broadcast authority. Signed bytes such
an attempt never sent end only on proven nonexecution (`unsentVerdict` in
`operation-observation-rpc.ts`): the finalized height is past their last valid
block height and every pool endpoint, floored at that finalized slot, misses
them inside `VERDICT_HISTORY_HORIZON_BLOCKS`. Then the operation is `failed`
`TRANSACTION_EXPIRED`, even after a cancellation request: a terminal `cancelled`
needs an authoritative resource reference, which unsent bytes never have. An
endpoint that cannot answer, or an expiry past the horizon, keeps waiting and
logs. A
synchronous signer's `CUSTODY_POLICY_REFUSED` is a definitive refusal: the
operation ends `failed` with that code, as a rejected proposal does. Only
verified chain/provider observations establish payout; never copy expected
amounts into settled fields. A projection of movement or request evidence
replaces an earlier pass's recovery error; a terminal operation keeps its own.

Provider-order source finality records only the opening leg and leaves the
operation `settling`. `EarnProviderSettlementProvider` supplies a correlated
candidate; the shared verifier requires successful finalized delivery to the
recorded owner, mint and required account. A reported output amount only
cross-checks the observed token delta. Missing orders, hashes or receipts stay
unresolved. Provider refusal or refund status alone cannot establish delivery,
a refund or nonexecution.

## Replacement boundary

Earn is prelaunch. Do not restore removed product endpoints, create historical
operation projections, adopt old builds or add saved-intent upgrade logic.
The current core contract is the only supported flow. Durable recovery applies
to operations created through that contract.

## Positions and provider reads

Positions are project/environment scoped. Registered wallet visibility and
owner-address filtering remain distinct access checks. A withdrawal uses the
position's stored source and strategy even when deposits are paused or the
strategy is delisted. `discover=true` requires one explicit source and supported
integrated catalogue coverage; it does not promise all ecosystem holdings.

`vault-position-hydration.ts` owns batched live reads and empty-position closure.
Do not close a position from an unavailable or insufficiently final read.
Preserve minimum-slot context from `afterMovementIds`; dashboard balances and
positions must both observe that context before replacing their paired snapshot.
Queue escrow and intermediate holdings cannot disappear as zero positions.

Summary totals cover the whole selected scope, not just a position page.
Unavailable values remain absent; a partial total cannot appear complete.
Customer drill-down requires explicit owner/position flags. Discovered holdings
have unknown acquisition time and cost basis. A live balance is not earned yield.
A withdrawal through a selector that names a tracked holding resolves to it,
as position detail does, and keeps its cost basis. An imported holding stays
visible and active without a successful movement, so a failed first exit never
hides it.

Apply `packages/sdp-earn/CLAUDE.md`'s RPC budget: batch independent inputs, share
identical concurrent work only within exact authorized scope, cache static facts
without caching failures, and do not fetch an account twice. Fresh reads after
movement confirmation cannot join work begun before their freshness boundary.
State before/after request counts when changing read or quote behavior.

Operation recovery claims from the `(environment, next_check_at, id)` partial
index with four competing consumers per environment. PostgreSQL commit hints,
startup/reconnect scans and a two-second fallback wake the same consumers;
notifications contain no authority. Lease only work ready to start.
Error-free execution work rechecks every two seconds for the first two minutes
after acceptance. Older pending work backs off from 15 to 300 seconds, capped
at 60 seconds for `sign_in_provider`; status progress resets it to 15 seconds.
Observe existing movement/request ledgers before resolving transaction builds.
Within a 25 ms observation window, share a lazy RPC client and observations
only for the exact organization, project, environment and recorded principal.
Four concurrent same-authority status requests become one batch; two
custody-proposal height reads become one. Batch at most 256 signatures, evict finished status batches
and failed heights, and never treat absence or a cached failure as nonexecution.
An unsent-bytes proof shares one finalized height read per window and scope.
Past expiry, each proof reads floored status once per pool endpoint.

Direct movement and queued-action signatures share bounded status batches in
the fast observer. The minute recovery sweep reads one unleased snapshot and
shares its status, conditional finalized height and expired-absence proof reads
across the batch. It then acquires the same fenced claims four rows at a time.
Evidence stays within that invocation and must match the fresh row's exact
signed transaction; changed state or absence markers invalidate negative
evidence. Never add signing, rebroadcast or expiry inference to the fast lane:
it only feeds observations through the existing financial reducers. Keep queued
escrow distinct from payout and unknown amounts unknown.
The observer may skip optional holding closure; a detail read that closes an
empty holding must return its persisted closure in that same response.

Expired solver recovery adds zero provider reads without an eligible recorded
request and one live proof read on the usual path. Skip stale closed or no-longer
expired candidates in position-scoped creation order, capped at three proof
reads instead of unbounded N+1 reads. Stop at the first proven recovery; never
scan another position. After three stale candidates, one database lookahead
returns no recovery if exhausted or defers recovery if more remain. Deferred
recovery omits only that option; other available routes remain usable. With no
surviving route, return retryable `503 SERVICE_UNAVAILABLE`. Actual proof or
provider-read failures still fail closed. Reusing that call's validated proof
in build admission avoids a duplicate proof read before existing provider
validation and simulation. Never persist
that evidence or accept it from a caller; every later preparation or refresh
reads fresh provider state.
Offer one recovery choice per review.
Route reads degrade independently, but when no route survives, an unreadable
provider or an unusable swap quote (`SWAP_UNAVAILABLE`) answers `503`, never
the no-route `400`. Reads of a recorded
obligation (expired escrow, pending release) fail closed through
`rethrowVaultProviderFailure`.
Returning shares is `settlementOutcome: recovered`, not delivered asset payout.
The new reviewed withdrawal retains source grants and leaves the original
operation's post-submit cancellation barrier intact.

Hastra release uses `release_current_redemption`, with explicit selection even
when it is the only route. A bounded project/position lookup must find a known
pending operator redemption before one live provider request read. This is
consent to release the request current at execution, including a replacement;
never describe it as cancelling a historical amount or cycle. Its canonical
operation-only operator-cancel build has no historical request ID, and its
consumed attempt and PDA reservation fence competing SDP actions while pending.
Complete only from its own finalized cancellation signature and provider
proof, not a missing account or an unrelated closure. Acceptance freezes
financial reconciliation of earlier matching Hastra requests until definitive
no-effect failure; finalized release keeps that freeze permanently. A release
that never lands is such a failure: once finalized height passes its last valid
block height SDP never resends it. A second finalized miss at least 30
seconds after the first hands it to the shared `unsentVerdict` proof, and only
every endpoint's floored history missing it, with at least two distinct
endpoints answering, fails it `TRANSACTION_EXPIRED`. A single endpoint leaves
it pending; two pooled misses can come from a lagging or pruned backend. An observation-only
release is adopted for the same proof. Match the organization, project, environment,
position, owner, custody source, provider, PDA and mints. Causal row ordering is local bookkeeping, never onchain cycle
proof. Leave the historical financial row unchanged; end its operation with
`REDEMPTION_SUPERSEDED`, null settled amount and null settlement outcome. This
terminates tracking without proving nonexecution or permitting an automatic
retry. Covered requests and actions leave background polling. Close the current request and
revoke only Hastra's burn delegation if still present; preserve unrelated
delegates. Guarantee no unlocked
amount. Completion is `settlementOutcome: recovered` with `settledAmount: null`,
with no PRIME return, USDC payout or payout movement.
Keep the existing exact-byte signing and post-submit cancel/refresh barriers.

A trusted operator can recover a finalized release with unreadable events
through `earn:redemption-release:recover`, using exact accepted identifiers,
independently verified evidence and an explicit attestation. The command checks
its finalized successful receipt and commits evidence, completion, cooldown and
audit atomically under a fresh worker claim. See
`docs/ops/earn-redemption-release-recovery.md`. Automatic event verification
remains required in the normal worker.


Atomic swap-funded builds retain one compute probe and one final simulation per
attempt. An oversized request no longer reads a split baseline balance or runs
two standalone-swap simulations. Successful atomic builds make no extra reads.

## Storage and checks

`earn_movements` and `earn_positions` remain financial authority. Operations
coordinate execution; provider withdrawal requests own their obligations.
Canonical wallet transaction tables store new builds and enforce tenant RLS.
Old build tables remain unused by the replacement, with no copying or dual
writes. Strategy references retain synchronized aliases where current ledger
writers still use them. The schema-only companion removes the five unused
legacy tables after this rewrite is serving, including retired provider-wallet
positions and movements. Current wallet holdings and async recovery remain.
HTTP compatibility routes are not required.

Run core routes, operations repository/recovery/worker and affected provider
service tests. Keep explicit regression coverage for exact-byte retries,
revocation, ambiguous outcomes, cancellation/submission races, tenant isolation, minimum
slot/finality, unknown amounts and route removal. Also run action inventories,
production exit policy, typecheck, Biome and generated-artifact drift checks.
Provider sandbox and signed-in browser outcomes require separate live evidence.
