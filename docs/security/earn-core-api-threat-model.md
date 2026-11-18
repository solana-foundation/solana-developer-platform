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
- A discovered holding is claimed only with verified signed intent, atomically
  with its first movement. It receives no synthetic deposit, acquisition
  history, cost basis or earnings.
- Old submission URLs and their unused wrappers are removed. Every supported
  operation enters through core preparation and the shared async worker.
- Deposit acceptance requires its critical audit intent. Exit auditing retains
  the existing best-effort posture so an audit outage cannot trap funds.

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

The four core Earn routes and five operation routes remain internal. The old
53 non-onboarding routes are removed rather than mounted as compatibility URLs.
Public promotion requires named security sign-off. No production migration,
provider sandbox flow or signed-in browser flow is established by local tests.

Migrations are additive while the previous revision serves traffic. Canonical
wallet transaction tables start empty, enforce tenant RLS and retain the build
constraints needed by current operations. Old builds are neither copied nor
resumed. Strategy references retain synchronized aliases where current ledger
writers still use them. Old physical objects remain until a separate schema-only
deployment can remove them. No historical action adoption or compatibility
execution path is supported.
