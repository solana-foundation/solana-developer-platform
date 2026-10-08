# 0008. One Idempotency-Key middleware

Date: 2026-10-08
Status: Accepted for the core (HOO-1918 PR 1). PR 2 makes first-party clients send keys; PRs 3–5
apply the step to routes.

## Context

`Idempotency-Key` is optional on every `/v1` route. In the `stable` modules, only transfers and
transfer batches act on it. Each module that does handle keys has its own implementation:

- Payments, issuance, DvP, Earn and private channels each keep a keyed row with a hand-written
  fingerprint.
- A key reused with a different request returns 409.
- A replay of a failed request returns 200.
- Recurring payments have no key handling at all.
- Key scope differs by module: org, project, or project without the org.

SDP launches on mainnet on Nov 2 with keys required on the routes that move money (HOO-1918).

## Decision

One route step, `idempotent({ key })` in `apps/sdp-api/src/middleware/idempotency.ts`, backed by
one table, `idempotency_keys` (migration 0126). It follows three sources:

- [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
  for the header and the 400/422/409 codes.
- [Stripe](https://docs.stripe.com/api/idempotent_requests) for snapshot replays, 24h retention,
  `Idempotent-Replayed`, and refusals that occupy nothing.
- Brandur Leach's [Postgres design](https://brandur.org/idempotency-keys) for the locked key: a
  lease plus a claim token, compare-and-swapped on every write.

**Scope.** Organization, project, and operation. The operation is the HTTP method plus the Hono
route pattern, read with `routePath(c)`, so it needs no shared vocabulary that could drift from
`OPERATION_TYPES` or `MOVEMENTS`.

- The step must sit in a route's own chain. It throws if the pattern is a `use("*")` wildcard.
- Renaming a path resets that route's keys, which is acceptable with 24h retention.

**Fingerprint.** SHA-256 over canonical JSON (keys sorted by code unit) of the parts below. The
credential is recorded on the row and compared in plain text rather than hashed:

- the operation, path parameters, query parameters (repeated values in order) and body;
- the credential (API key id or user id), so another credential reusing the key gets 422 and
  never reads a response produced for different wallet access. A retry made after rotating the
  API key is therefore a new request; the resource row's own unique key still stops it moving
  money twice;
- the Dry-Run flag, so a dry run never replays as the real request.

A route can pass `canonicalize` where two spellings mean one request, such as unordered batch
recipients.

**Order.** Authentication → project context → `requirePermissions` → Allowed Operations → **this
step** → admission → validation → handler.

- A replay re-checks the caller first.
- A replay is not admitted again, because it isn't a new movement.

**Outcomes.**

| Case | Stored? | Answer |
|---|---|---|
| No key on a `required` route; malformed key | No, nothing claimed | 400 (`IDEMPOTENCY_KEY_REQUIRED`) |
| Same key, different fingerprint | No | 422 `IDEMPOTENCY_KEY_REUSED` |
| Original still holds its lease | No | 409 `IDEMPOTENCY_KEY_IN_FLIGHT` + `Retry-After` |
| 400, 401, 403, 409, 429 (validation, admission, permissions, conflicts) | No: a fresh claim is deleted, a taken-over one unlocked | Live; the same key runs again |
| 5xx, default `serverErrors: "store"` | Yes, like Stripe | Replayed; retry with a new key |
| 5xx, `serverErrors: "rerun"` | No: unlocked, still bound to its fingerprint | A same-key retry runs again |
| 2xx and other 4xx | Yes, 24h | Same status and body + `Idempotent-Replayed: true` |

- `rerun` is only for a route whose handler writes its own row under a unique key before it moves
  anything. That row recovers the earlier attempt.
- An error thrown past a composite caller (such as `requireMovement`) is stored only if it is an
  `AppError`, whose status is known. Any other error is mapped by the app's handler, so the key is
  unlocked and stays bound to its request instead of storing a guess.
- A success is never unlocked. A body over 1 MiB is stored without its body, and a bodyless status
  (204, 205, 304) replays without one.

**Lease.** 60 seconds by default, set per route, and renewed every third of the lease while the
handler runs. A crashed request's key frees when the lease runs out.

**Bypass.** Approved-operation executions skip the step: they re-send the original key to execute
the operation, not to replay it. The bypass goes away with approvals (#2236's stack).

**Retention.** 24 hours. Expired rows are pruned hourly in-process and on every run of the managed
reconciliation job. A claim ignores an expired row.

**Declaration.** The step carries `Symbol.for("sdp.idempotency")` with its mode. `IdempotencyKeyMode`
lives in `@sdp/types`.

- When HOO-1955's `requireMovement` lands, it composes `runIdempotency` between Allowed Operations
  and admission. `MovementDefinition` gains `idempotencyKey: IdempotencyKeyMode`.
- The route passes the API-only options as `requireMovement(id, { idempotency: { leaseSeconds,
  canonicalize, serverErrors } })`.
- When the route-declarations primitive lands, the marker becomes `RouteDeclaration.idempotency`.

## Consequences

- A replay is only ever served to the credential that made the original request.
- Response bodies are stored in plaintext for 24h under forced RLS. Routes that return secrets
  never use the step; `routes/idempotency-route-exclusions.test.ts` pins API key and provider
  credential routes.
- Before a route takes accept mode, check its response for regulated data, such as counterparty
  bank details.
- Replays return what was stored. The current state is a GET away.
- Modules outside `stable` keep their own key handling until promoted. Their row fingerprints then
  become the backstop.
