# Earn routes

Earn is an aggregation API. Strategies are catalogue items; positions are
holdings; operations coordinate deposits and withdrawals. Treasury and Embedded
Yield consume the same contract. Do not add product-specific routes or restore
program creation, allocation configuration or automation.

## Route contract

`index.ts` mounts four core operations and six WisdomTree eligibility operations:

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

`EARN_PUBLIC_SURFACE_PUBLISHED=false` in
`openapi/release-channel-values.ts` holds Earn out of every public surface,
including provider availability and grantable-action discovery. The runtime's
release-channel gate remains separate. The four core and five operation routes
are internal until named security sign-off (PRO-1872/PRO-2038). Do not widen a
publication test or publish a replacement merely because its predecessor was
public. `openapi/spec.test.ts` pins the internal inventory and public exclusion.

Update OpenAPI descriptions, authored guides and dashboard clients together.
Regenerate OpenAPI, route actions, served paths, playground, API reference,
Postman, AI resources and module map using their owning generators. Generated
files must not be edited manually. The internal consumer guide lives at
`apps/sdp-docs/content/unpublished/earn/core-api.mdx`.

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
Observation-only attempts never regain broadcast authority. Only verified
chain/provider observations establish payout; never copy expected amounts into
settled fields.

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

Apply `packages/sdp-earn/CLAUDE.md`'s RPC budget: batch independent inputs, share
identical concurrent work only within exact authorized scope, cache static facts
without caching failures, and do not fetch an account twice. Fresh reads after
movement confirmation cannot join work begun before their freshness boundary.
State before/after request counts when changing read or quote behavior.

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
