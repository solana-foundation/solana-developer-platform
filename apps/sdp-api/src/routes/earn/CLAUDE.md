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

Shared `/v1/operations` supplies list, detail, execute, refresh and cancellation.
There are no other Earn catalogue, preview, build, submit, movement or program
HTTP wrappers. Only current operation history and async recovery belong in operations.
Protocol-specific builders and ledger repositories remain shared domain code.

Every route declares an action. Reads use `earn.read`; preparation and execution
use `earn.execute`; cancellation intent uses `earn.manage`. A separately reviewed
on-chain cancellation action also requires `earn.execute`.

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
strategy before idempotency. Sources contain exactly one `walletId` or
`ownerAddress`. Never infer source authority from a provider reference, replace
it during withdrawal, or accept a caller-selected payout destination.

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

An attempt remains immutable after refresh. Preserve signed bytes and identity
until a definitive outcome is known.

## Execution and async recovery

The shared operations service durably accepts an exact `actionId` and version.
The worker performs every signature, provider proposal and broadcast, including
fast signers. No status read performs money work. A provider URL is approval
instruction, not proof of approval or settlement.

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
Refresh only after definitive refusal, safe expiry or authoritative resolution;
new terms require another review. Otherwise retain `wait` and the same attempt.

Cancellation records sticky intent. Observation-only attempts never regain
broadcast authority. Queue acceptance, escrow, cancellation acknowledgment,
returned shares, intermediate tokens and delivered assets are separate facts.
Only verified chain/provider observations establish payout. Never copy expected
amounts into settled fields.

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

## Storage and checks

`earn_movements` and `earn_positions` remain financial authority. Operations
coordinate execution; provider withdrawal requests own their obligations.
Canonical wallet transaction tables store new builds and enforce tenant RLS.
Old build tables remain unused by the replacement, with no copying or dual
writes. Strategy references retain synchronized aliases where current ledger
writers still use them. Old physical objects require a separate schema-only
deployment to remove; HTTP compatibility routes are not required.

Run core routes, operations repository/recovery/worker and affected provider
service tests. Keep explicit regression coverage for exact-byte retries,
revocation, ambiguous outcomes, queued cancellation, tenant isolation, minimum
slot/finality, unknown amounts and route removal. Also run action inventories,
production exit policy, typecheck, Biome and generated-artifact drift checks.
Provider sandbox and signed-in browser outcomes require separate live evidence.
