# Earn core operations

Change tier: **Critical**. This change moves Earn signing and submission from
HTTP handlers into durable, authenticated worker actions. It changes the
authorization and recovery boundary, not custody ownership.

## Assets and actors

Assets include customer strategy shares, deposit tokens, redemption claims,
signed transactions, sponsor funds and the integrity of financial history.
Actors are project members, API keys, wallet owners, custody providers,
Earn providers and the operation worker. A strategy listing conveys neither
deposit eligibility nor authority over a wallet.

## Boundaries

| Boundary                     | Control                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller to preparation        | Authentication, project/environment scope, wallet binding and exact resource ownership precede idempotency. Mutable deposit admission follows replay.                         |
| Preparation to execution     | An immutable intent and private source bind a versioned, reviewable action to its authenticated principal. Changed terms require another review.                              |
| HTTP to worker               | Submit persists authorization for the exact reviewed transaction and owner-signed bytes. It does not prepare, sign, propose or broadcast. The worker rechecks live authority. |
| Worker to custody            | Existing custody and sponsorship waists admit the named movement. A durable account binding precedes the single provider create.                                              |
| Signature to ledger          | Every required signature and the complete prepared message are verified. Signed intent commits before broadcast.                                                              |
| Chain to provider settlement | Signing, chain inclusion and economic delivery remain separate observations. Requested amounts and queue escrow are not payout evidence.                                      |

## Failure and abuse cases

- A foreign strategy, position, operation or build ID cannot cross project or
  environment scope. Address-scoped history requires an explicit owner filter;
  an unfiltered feed contains registered-wallet operations only.
- A changed wallet, fee payer, transaction message or signature cannot replace
  the reviewed action. Prepared sources are checked again against the stored
  operation source at the execution adapter.
- The API-key and `ownerAddress` path needs no SDP wallet registration or
  provider connection. An address alone grants no signing authority: every
  required signature must verify over the unchanged prepared message. An
  existing connected `walletId` is optional and retains its live wallet grants.
- A stale action/version cannot submit or select a different withdrawal route.
  Refresh is preparation-only before any submit acceptance. It selects an
  advertised route or safely replaces unsigned terms, returning a new review.
  It retains the selected route; an unavailable route fails instead of silently
  choosing another.
- Every new Earn sign, proposal, sponsorship and broadcast requires a fresh
  `earn.execute` check. API-key grants and member role/project access are read
  again at the money boundary. Refusal restricts the attempt to observation;
  known bytes and provider cleanup remain recoverable. This explicit Earn
  action check preserves the shared admission layer's default exit semantics.
- Swap-funded deposits contain both swap and deposit instructions in one
  transaction, sized to guaranteed output and simulated together. Oversized
  compositions fail before a build is persisted. No standalone funding swap
  can leave the operation swapped but undeposited.
- Concurrent workers use fenced leases. Dispatch is recorded before a provider
  create. A takeover reads the original provider identity; a missing lookup or
  timeout never permits another create.
- The 180-second lease outlives the 120-second action budget. Workers reserve
  each external boundary before starting it and stop claiming new work when
  their run budget expires. A timed-out workflow is never raced as a whole.
- Signed bytes remain recoverable after an uncertain send. Recovery retries
  those exact bytes, with their original identity. Expiry and missing RPC
  history do not prove non-execution.
- Public cancellation requires `canCancel` and no accepted submit anywhere in
  the operation's history. Its state check serializes against submission;
  refresh cannot reset it. An exposed owner message with an unknown outcome
  cannot be cancelled. Route authorization remains independently required.
  Internal cleanup for permission loss or expiry is private worker safety, not
  caller cancellation. Observation-only restriction remains irreversible.
- Refresh and cancel reject after any submit acceptance, including after a
  custody signing refusal. Definitive rejection or proven nonexecution makes
  the operation terminal `failed`; only then can a new request/key create a
  replacement. An uncertain provider response, timeout or missing RPC history
  never permits one. Internal cleanup is observed before resolving an attempt.
- Solver escrow recovery is a new `earn.withdraw` intent with `earn.execute`
  and the position's current wallet grants. It does not reopen the accepted
  operation or grant post-submit `/cancel` authority. Explicit option selection
  and a fresh review bind the returned shares to the same owner and strategy.
  Live provider state must match the recorded request address, nonce, creation
  time, deadline, mints and shares, and prove the deadline passed.
- Solver recovery completion requires the exact finalized cancellation action from
  this operation's attempt and consumed canonical build. Its signature must
  match both the request's cancellation and authenticated closing signatures.
  Provider lifecycle evidence must prove the returned share quantity. The
  result says `recovered` in the share mint, never copies expected asset payout.
  A different verified closure fails the recovery; unknown outcomes still wait.
- An independently broadcast solver recovery can consume its exact operation-only
  build only after those signed bytes match the authenticated terminal closing
  transaction. Action persistence and build consumption are atomic; the
  cancelled request stays terminal. This cannot adopt historical builds.
- Hastra release is a separate reviewed withdrawal option for a tracked
  position with a known pending operator redemption in the same project. The
  owner consents to release the redemption current at execution, including a
  replacement. The instruction has no amount/cycle guard; history is not used
  to claim one. The option requires explicit selection even when it stands alone.
- Its canonical operator-cancellation build has no historical request ID. Build
  consumption binds one operation attempt, and a PDA-scoped reservation fences
  competing SDP redemptions/releases through unresolved signing and broadcast.
  Completion requires its own finalized cancellation signature and provider
  evidence. Another transaction closing the request is not release evidence.
- Acceptance freezes earlier matching Hastra financial reconciliation while
  release is unresolved. Finalized release keeps that freeze permanently;
  definitive no-effect failure lifts it. Equal-amount replacement events must
  never create a fictional earlier payout. Match organization, project,
  environment, position, owner, custody source, provider, PDA and mints. Causal
  row ordering is local bookkeeping, never proof of an onchain request cycle.
- Release never changes the original request's recorded outcome or creates a
  payout movement. The original can remain unresolved; only the new release
  operation completes. It closes the current request and revokes Hastra's
  burn delegation if present, preserving unrelated delegates. It guarantees no
  unlocked amount.
  The result says `recovered` with no settled amount, not recovered PRIME or USDC.
  Missing evidence, timeouts and ambiguous broadcasts retain the reservation.
- Indexed due-time scans feed at most four workers, which lease only work ready
  to start. Backoff changes observation timing, never spend authority. Shared
  RPC observations stay within one run and the exact organization, project,
  environment and recorded principal; failed or absent signature reads are not
  cached as outcome evidence.
- A discovered holding is claimed only with verified signed intent, atomically
  with its first movement. It receives no synthetic deposit, acquisition
  history, cost basis or earnings.
- Old submission URLs and their unused wrappers are removed. Every supported
  operation enters through core preparation and the shared async worker.
- Deposit acceptance requires its critical audit intent. Exit auditing retains
  the existing best-effort posture so an audit outage cannot trap funds.

Single-position reads use the same project, environment and read visibility as
position lists. A selected-wallet spending restriction cannot hide a position
from an authorized reader or grant new spending authority. Discovered IDs are
source selectors, never authorization; they are checked before provider reads
and do not import holdings.

## Residual risks and release gates

Custody signing policy, provider liquidity, issuer redemption, RPC history,
SDK correctness and on-chain programs remain independent trust dependencies.
An owner may independently broadcast signed bytes; SDP cannot revoke them.
Public cancellation is unavailable while that outcome is unknown. A missing
final outcome may remain unresolved.

`awaiting_signature` and `sign_in_provider` describe configured-wallet signing.
The custody adapter can enforce provider approval policies and retain proposal
state internally; those controls are not a separate Earn approval feature.

Operations retain the original action principal. Rotating or revoking that
credential can require an authorized recovery path; a different key does not
automatically acquire authority to submit its prepared action.

Catalogue coverage and execution coverage are distinct. A discovery-only
strategy cannot enter the deposit path. Expanding assets beyond current stable
token exposure accounting requires appropriate valuation and safety controls.

Hastra's reusable owner request address can change between preparation and
execution. Its release option therefore authorizes the current redemption,
including a replacement, rather than promising a cycle-specific cancellation.
This scope needs security review. SDP's reservation covers its own attempts;
it cannot prevent direct wallet or provider actions. Only tracked positions
with a known pending request are covered. Release does not ensure wYLDS remains
transferable: issuer freezes and program restrictions still apply.

The five core Earn routes and five operation routes follow Earn's existing
release-channel publication rules. The old 53 non-onboarding routes are removed
rather than mounted as compatibility URLs. The PR keeps public route inventory
explicit for security review. No production migration, provider sandbox flow or
signed-in browser flow is established by local tests.

Migrations are additive while the previous revision serves traffic. Canonical
wallet transaction tables start empty, enforce tenant RLS and retain the build
constraints needed by current operations. Old builds are neither copied nor
resumed. Strategy references retain synchronized aliases where current ledger
writers still use them. A schema-only companion removes five obsolete tables
and the retired provider-wallet position link after the rewrite is serving.
Old prelaunch provider positions and movements are deliberately discarded; live
wallet positions, movements and recovery records remain. The breaking migration
uses the serving-parent deployment gate and permits only forward recovery. No
historical action adoption or compatibility execution path is supported.

Hastra address reuse requires parent-first cleanup. Parent `0238` retains the
existing address index; schema-only child `0239` removes it only after the
guarded parent serves. The global PDA lock and durable lease continue to
serialize requests. Removing the index neither resolves historical requests nor
permits assigning them a replacement redemption's financial outcome.
