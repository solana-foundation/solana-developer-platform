# ADR 0007: Money admission and the admitted-movement capability

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** SDP engineering (HOO-1955)
- **Related:** ADR 0002 (money out beats money off); ADR 0005 (release channels); ADR 0006 (Allowed Operations); `apps/sdp-api/src/lib/money-admission.ts`; `apps/sdp-api/src/lib/admit-movement.ts`; `packages/sdp-types/src/movements.ts`; `scripts/check-value-movement.mjs`

The number is provisional: take the next free one when this merges.

## Context

APE-351 refuses a production project at the HTTP edge once its organization
loses the production entitlement. Background jobs and `/pay` move money with
no authenticated actor, so nothing at the edge checks the organization for
them. A deleted organization kept collecting recurring payments, and a
production project without the entitlement kept activating and resuming them.

Checking at each place that starts money works until someone adds a place and
forgets. SDP has few places where money actually leaves (custody signers and
sponsored fee payers) and many places that start it.

## Decision

One decision, required by the sinks.

- **One decision point.** `admitMovement(env, scope, movement)` reads the
  project and its organization in one uncached join and decides:

  | Organization         | Project                                 | Start  | Exit  |
  | -------------------- | --------------------------------------- | ------ | ----- |
  | active               | sandbox, or production with entitlement | admit  | admit |
  | active               | production without the entitlement      | refuse | admit |
  | suspended or deleted | any                                     | refuse | admit |

  It is the only way to get an `AdmittedMovement`. Every refusal emits one
  `sdp_money_refused` event and throws a 403.
- **Sinks accept only the token.** Custody signer acquisition, wallet runtime
  admission and project sponsorship take an `AdmittedMovement` and read the
  organization and project only from it, through a reader that rejects
  anything admission did not mint. The token carries the facts admission read,
  so a sink acts on the same snapshot and reads nothing again.
- **One vocabulary.** Movements live in `@sdp/types` (`MOVEMENTS`): an id
  that is never renamed, its module, its kind, and the Allowed Operation an
  API key must hold for it.
- **Exits are never refused** (ADR 0002). An exit only returns value or
  obligations the organization already committed and creates no new exposure,
  supply, authority or delegation. Everything else is a start, including a
  signature that moves nothing. Classifying a movement as an exit needs a
  security review.
- **HTTP admits once, at the route.** `requireMovement(id)` is the one
  declaration a money-moving route carries. It runs the Allowed Operations
  check, admits before validation or any write, and puts the token on the
  context. A refused start writes nothing.
- **Jobs admit lazily.** A job asks only once the operation knows it still has
  to sign. Work that is already signed only confirms, so a refusal never
  strands an operation that is on chain.
- **Refusals are durable, visible and do not loop.** Each job moves a refused
  item to a state it no longer selects. Recurring collection records a
  `skipped` attempt and moves to the next boundary, under the lock collectors
  take before they sign. Nothing is caught up after re-entitlement; the
  subscriptions program forfeits elapsed periods too. Activation goes back to
  `pending_activation`, resume back to `canceled`.
- **Enforcement is resolved, not grepped.** `scripts/check-value-movement.mjs`
  resolves references with the TypeScript checker and pins which files may
  mint, use the escape hatch, or reach the raw signer and sponsorship
  constructors. Every cron monitor is classified in `cron/money-effects.ts`,
  and an unclassified one does not typecheck.

## Migration

Modules outside `stable` mint through `uncheckedLegacyMovement`. It reads the
same join but refuses nothing, and logs `decision: "would_refuse"` where
admission would refuse, so each module's slice starts from data.

- `LEGACY_MOVEMENT_MODULES` cannot list a `stable` module. Promoting a module
  fails the build until its hatch calls are gone.
- The checker's hatch and raw-sponsorship allowlists are shrink-only. A file
  that stops using the hatch must leave the list.
- Each slice adds its module's movements, mints at its routes and job entries,
  and removes its hatch calls: ramps (the BVNK payout, which pays out for
  revoked and deleted organizations alike), issuance, Earn, DvP, private
  channels, then Helius Rings. The last slice deletes the hatch.

## Consequences

- A new path to a signer or a sponsored fee payer cannot compile without a
  token, and a new file that mints one fails CI until it is reviewed.
- An HTTP money request reads the organization once for authentication and
  once for admission. Runtime admission no longer reads it again.
- A deleted organization's scheduled work stops starting money and shows its
  refusals: in the collection history, the attempt journals, and the
  `sdp_money_refused` event. A deleted organization has no HTTP access, so an
  operator handles anything it still needs to take out.
- Request-scoped sponsorship (transfers, batches, subscription prepare routes,
  signer checks) does not take a token yet. It runs behind authentication and
  `projectContextMiddleware`, and the checker pins its callers until it moves.

## Alternatives considered

- **A guard at each job.** Closes today's gap but cannot stop the next job
  forgetting it.
- **Suspend everything on deletion or revocation.** A second copy of a fact
  admission can read directly; it drifts, and it needs a state for every
  module.
- **Enforce only at the sinks.** A sink cannot apply job-specific refusal
  states (skip a period, revert an activation); the origin decides and the
  sink checks.
- **Regex route tables and source-text tests.** Brittle: a renamed route
  silently closes an exit, and text matching misses aliases. Declarations
  live on the route and the checker resolves symbols.

## Open questions

- Should production projects require a `stable` module stage whatever the
  deployment's channel (compare the production custody ADR, HOO-1970)?
- Who confirms positions are settled before a module leaves a release
  channel, since that stops its exits (ADR 0005)?
- Is Helius Rings `unshield` an exit?
