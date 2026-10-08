# 0006. One Idempotency-Key middleware

Date: 2026-10-08
Status: Accepted for the core (HOO-1918 PR 1). Route coverage lands in PRs 3–5.
Number: provisional. Take the next free number on the merge base when this merges.

## Context

`Idempotency-Key` is optional on every `/v1` route. In the `stable` modules, only transfers and
transfer batches act on it, and each module that does has its own implementation:

- Payments, issuance, DvP, Earn and private channels each have a keyed row and a hand-written
  fingerprint.
- A mismatch returns 409.
- A replay of a failed request returns 200.
- Recurring payments have no key handling at all.
- Key scope differs by module: org, project, or project without the org.

SDP launches on mainnet on Nov 2 with keys required on the routes that move money (HOO-1918).

## Decision

One route step, `idempotent({ key: "required" | "accepted" })` in
`apps/sdp-api/src/middleware/idempotency.ts`, backed by one table, `idempotency_keys`. It follows
[draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
and Stripe, and borrows the locked key from Brandur Leach's
[Postgres design](https://brandur.org/idempotency-keys).

- **Scope.** Organization, project, and operation = HTTP method + Hono route pattern. The pattern
  comes from `routePath(c)`, so no shared vocabulary is needed: it can't drift from
  `OPERATION_TYPES` or `MOVEMENTS`.
- **Fingerprint.** SHA-256 over canonical JSON of the operation, path parameters and body. Object
  keys are sorted; arrays keep their order. A route may pass `canonicalize` where two spellings
  mean one request.
- **Order.** Authentication, project context, `requirePermissions` and Allowed Operations run
  first, so a replay re-checks the caller. Then this step. Then admission and validation, so a
  replay is not admitted again as a new movement.
- **Responses:**
  - Missing key on a required route: 400 `IDEMPOTENCY_KEY_REQUIRED`.
  - Same key, different fingerprint: 422 `IDEMPOTENCY_KEY_REUSED`.
  - Original still holds its lease: 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`.
  - Completed key: the stored status and body, with `Idempotent-Replayed: true`.
- **What is stored:**
  - 2xx and 4xx responses other than 400, 401, 403, 409 and 429 are stored for 24 hours.
  - Refusals are not stored, so the same key works after the cause is fixed. This follows
    Stripe, which doesn't save validation failures or concurrent conflicts.
  - 5xx and thrown errors are not stored either. The lease ends, and the row stays bound to its
    fingerprint, so a retry with the same request runs again. The handler's own row (unique on
    the key, written before broadcast) is the recovery point.
- **Lease.** 60 seconds by default, set per route. Every write after the claim is a
  compare-and-swap on the claim token.
- **Bypasses.**
  - `Dry-Run: true` requests skip the step.
  - Approved-operation executions skip it too. They re-send the original key to execute the
    operation, not to replay it.
- **Retention.** 24 hours. A sweep deletes expired rows hourly in-process, and on every run of
  the managed reconciliation job. A claim ignores an expired row.
- **Declaration.** The step carries `Symbol.for("sdp.idempotency")` with its mode, read by
  `declaredIdempotency` for route inventories. When HOO-1955's `requireMovement` lands, it
  composes `runIdempotency` between Allowed Operations and admission, and `MOVEMENTS` carries
  each movement's key mode.

## Consequences

- Routes that return secrets (API key creation, credential submission) must not use the step,
  because it stores bodies.
- Responses over 1 MiB are not stored; a retry runs the handler again.
- Replays return what was stored. Current state is a GET away.
- Modules outside `stable` keep their own key handling until they are promoted. Their row
  fingerprints then become the backstop.
