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

| Boundary                     | Control                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller to preparation        | Authentication, project/environment scope, wallet binding and exact resource ownership precede idempotency. Mutable deposit admission follows replay.                     |
| Preparation to execution     | An immutable intent and private source bind a versioned, reviewable action to its authenticated principal. Changed terms require another review.                          |
| HTTP to worker               | Execute persists acceptance and exact owner-signed bytes. It does not sign, propose or broadcast. The worker restores the recorded principal and rechecks live authority. |
| Worker to custody            | Existing custody and sponsorship waists admit the named movement. A durable account binding precedes the single provider create.                                          |
| Signature to ledger          | Every required signature and the complete prepared message are verified. Signed intent commits before broadcast.                                                          |
| Chain to provider settlement | Approval, chain inclusion and economic delivery remain separate observations. Requested amounts and queue escrow are not payout evidence.                                 |

## Failure and abuse cases

- A foreign strategy, position, operation or build ID cannot cross project or
  environment scope. Address-scoped history requires an explicit owner filter;
  an unfiltered feed contains registered-wallet operations only.
- A changed wallet, fee payer, transaction message or signature cannot replace
  the reviewed action. Prepared sources are checked again against the stored
  operation source at the execution adapter.
- A stale action/version cannot execute or select a different withdrawal
  route. Refresh preserves old attempts rather than changing their bytes.
- Concurrent workers use fenced leases. Dispatch is recorded before a provider
  create. A takeover reads the original provider identity; a missing lookup or
  timeout never permits another create.
- The 180-second lease outlives the 120-second action budget. Workers reserve
  each external boundary before starting it and stop claiming new work when
  their run budget expires. A timed-out workflow is never raced as a whole.
- Signed bytes remain recoverable after an uncertain send. Recovery retries
  those exact bytes, with their original identity. Expiry and missing RPC
  history do not prove non-execution.
- Cancellation records intent rather than pretending a payout or reversal
  occurred. Observation-only restriction is durable and irreversible for an
  attempt. Late signatures cannot authorize a fresh send after cancellation.
- A definite pre-submission custody refusal can permit refresh. An uncertain
  provider response cannot. Provider cancellation is observed before resolving
  the original attempt.
- A discovered holding is claimed only with verified signed intent, atomically
  with its first movement. It receives no synthetic deposit, acquisition
  history, cost basis or earnings.
- Legacy submit routes reject builds reserved for operations, including old
  versions left behind by refresh. They cannot bypass the async worker.
- Deposit acceptance requires its critical audit intent. Exit auditing retains
  the existing best-effort posture so an audit outage cannot trap funds.

## Residual risks and release gates

Custody provider approval, provider liquidity, issuer redemption, RPC history,
SDK correctness and on-chain programs remain independent trust dependencies.
An owner may independently broadcast signed bytes; SDP cannot guarantee that
cancellation revokes them. A missing final outcome may remain unresolved.

Operations retain the original action principal. Rotating or revoking that
credential can require an authorized recovery path; a different key does not
automatically acquire authority to execute its prepared action.

Catalogue coverage and execution coverage are distinct. A discovery-only
strategy cannot enter the deposit path. Expanding assets beyond current stable
token exposure accounting requires appropriate valuation and safety controls.

The four core Earn routes and five operation routes remain internal. Existing
published compatibility routes do not authorize publishing their replacements.
Public promotion requires named security sign-off. No production migration,
provider sandbox flow or signed-in browser flow is established by local tests.

Migrations are additive while the previous revision serves traffic. Canonical
strategy references retain synchronized legacy column aliases during that
window. Canonical wallet build views use the existing rows, constraints and
triggers with caller-enforced RLS. Legacy physical table names remain compatible
with the previous revision; no second ledger is introduced. Dropping those
aliases or drain-only recovery routes is a separate
deployment step after old revisions and obligations are gone.
