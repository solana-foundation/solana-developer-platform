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
one table, `idempotency_keys` (migration 0128). It follows three sources:

- [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
  for the header and the 400/422/409 codes.
- [Stripe](https://docs.stripe.com/api/idempotent_requests) for snapshot replays, 24h retention,
  `Idempotent-Replayed`, and refusals that occupy nothing.
- Brandur Leach's [Postgres design](https://brandur.org/idempotency-keys) for the locked key: a
  lease plus a claim token, compare-and-swapped on every write.

**Scope.** Organization, project, and operation. The operation is the HTTP method plus the Hono
route pattern, read with `routePath(c)`, so it needs no shared vocabulary that could drift from
`OPERATION_TYPES`.

- The step must sit in a route's own chain. It throws if the pattern is a `use("*")` wildcard.
- Renaming a path resets that route's keys, which is acceptable with 24h retention.

**Fingerprint.** SHA-256 over canonical JSON (keys sorted by code unit) of the parts below. The
credential is recorded on the row and compared in plain text rather than hashed:

- the operation, path parameters, query parameters (repeated values in order) and the body as the
  route's validator left it (defaults applied, values normalised), so two spellings the schema
  treats as one request match;
- the credential (API key id or user id), so another credential reusing the key gets 422 and
  never reads a response produced for it. A rotated API key is a new credential, so a same-key
  retry after rotation gets 422. The domain row is found by the key too, so a retry under a new key
  is a new request: after a rotation, read the resource with GET to learn whether the original
  request ran before sending it again.

A route can pass `canonicalize` where two spellings mean one request: unordered batch recipients,
decimal amounts (`"1.0"` and `"1"`) on the money routes, and an empty batch `options` object.

**Order.** Authentication → project context → `requirePermissions` → Allowed Operations →
validation → **`authorize`** → **this step** → replay from the domain row → admission → handler.

- **Authorize, then dedupe.** `authorize(fn)` (`middleware/authorize.ts`) checks that the caller may
  act on every resource the request names, in tenant scope, and hands what it loaded to the
  handler. It runs before this step, so a replay passes exactly the checks a new request passes,
  and nothing after this step checks access. The step refuses to run (500) on a route without an
  earlier `authorize` or `authorizeNone(reason)`; the stable route inventory pins every
  `authorizeNone` with its reason.
- **Access, never state.** `authorize` answers "may this caller act on these resources?" (an API
  key bound to the wallet, a schedule in the caller's project). A wallet-scoped key's bindings come
  from authentication, which reads them in its one uncached statement on every request (HOO-2048),
  deactivated wallets kept; `authorize` checks them synchronously against `getAuth(c)` and never
  re-reads them, so the replay of a request whose wallet was deactivated since is not refused.
  Every id the request names (a counterparty account, a ramp deposit, a custody wallet) is
  looked up in the project here, whatever its status, so a wrong id is never stored as a 404 for
  24 hours. State ("the wallet is active", "the schedule is active") stays in the handler. A state
  check before this step would refuse the retry of a request that succeeded (the schedule is
  active because the first activate worked) instead of replaying its stored answer. A credential
  narrowed since the original request gets 403; one narrowed in a way that still covers the
  resource gets the replay.
- **State refusals are stored.** A refusal the handler raises from state (an inactive wallet, an
  archived counterparty or counterparty account) is a 404 stored under the key for 24 hours, on
  purpose: the same request gets the same answer, and a request that should run now uses a new
  key.
- **Validation runs first** because a 400 is never stored: an invalid request claims nothing.
- A replay is not admitted again, because it isn't a new movement. Replay from the domain row also
  runs before admission, so a request that already ran is answered from its row even when
  admission would now refuse new work.
- Edge refusals deliberately run before replay, and that stays. Once an organization is deleted or
  loses production access, a same-key retry of a request that already completed is refused, not
  replayed: 401 when the organization (or its API key) is gone, 403 when it lost production access.
  A revoked organization is not special-cased to read status, and every new attempt is refused
  too, so nothing can pay twice. Do not move replay ahead of authentication or project context.

**Two layers.** This step is HTTP idempotency: one attempt per key, a stored answer for 24 hours,
and a guard against concurrent duplicates. It does no foreign dedupe. The route's domain row is the
recovery point:

- it is written under a **credential-bound record key** (`getIdempotencyRecordKey`: SHA-256 over
  the scope, organization, project, credential and key, as `deriveProviderRequestId` derives), never
  the raw client key. Past the key record's 24 hours the row is what answers a retry, and a replay
  only ever goes to the original credential, so another credential in the project sending the
  same key runs as a new request;
- it is written under its own unique key before anything is signed or sent, the signature and
  blockhash window are saved before broadcast, and the outcome is recorded before this step saves
  the response;
- a provider call carries a request id derived from the key, so the provider dedupes the retry;
- the reconciler settles unsettled rows from the chain; it never reads keys.

A takeover (a retry after the original's lease ran out) **never resumes** the earlier attempt. The
handler finds its row by key and answers from it; the reconciler settles or fails what the crashed
attempt left. Every handler on a `rerun` route is therefore re-entrant: a retry after a crash at any
point finds its row and never signs or sends twice. Unlike Brandur's design the recovery point lives
on the domain row, not the key row, because domain rows outlive the key's 24 hours and the
reconciler works from them.

Recurring payments carve this out: their cron resumes and completes a half-finished row (an
`activating`, `canceling`, `resuming` or `updating` schedule, or a collection in flight) from the
signature its attempt recorded; it does not fail the row. A replay of a
lifecycle action (activate, cancel, resume, PATCH, collect) finds the attempt its key claimed and
returns the schedule as it stands now, which may still be mid-transition; clients poll GET.

Custody wallet creation (`POST /v1/wallets`) moves no money but creates a provider wallet before its
row, so it has no row to write first and stays `serverErrors: "store"`. A keyed create derives a
request id from the key, scoped by organization, project and credential (the raw key never reaches
a provider), and records it with the fingerprint on the `custody_wallets` row (migration 0131). A
retry the key cannot answer (a takeover, or past 24 hours) is answered from that row by
`replayFromRecord` without calling the provider; another request on the same key is 422. That
replay returns the wallet as it is now (its current label and status), not as the first response
showed it. A crash
between the provider call and the row is covered only where the provider dedupes on the id:
Privy (`privy-idempotency-key` plus a derived `external_id`, looked up only when the create does
not answer with the wallet) and Coinbase CDP
(`X-Idempotency-Key` plus an account name seeded by the id). Fireblocks, Turnkey, Para, DFNS,
IBM Digital Asset Haven, Anchorage and Utila get no id from our clients, so that window can still
leave a second, unreferenced wallet there: a crash after the provider created the wallet and before
the row was written leaves an orphan provider wallet, and the retry creates another. The follow-up
is an intent row written before the provider call, which the retry finds and completes instead of
calling the provider again.

**Outcomes.**

| Case | Stored? | Answer |
|---|---|---|
| No key on a `required` route | No, nothing claimed | 400 `IDEMPOTENCY_KEY_REQUIRED` |
| Malformed key (not 1-255 printable ASCII) | No, nothing claimed | 400 `BAD_REQUEST` |
| Same key, different fingerprint | No | 422 `IDEMPOTENCY_KEY_REUSED` |
| Original still holds its lease | No | 409 `IDEMPOTENCY_KEY_IN_FLIGHT` + `Retry-After` |
| 400, 401, 403, 409, 429 refused before the handler writes its domain row (validation, admission, permissions, conflicts) | No: a fresh claim is deleted, a taken-over one unlocked | Live; the same key runs again |
| Any status once the handler has written its domain row (`markIdempotencyCommitted`), such as a 400 `TRANSACTION_FAILED` after the transfer row | Yes, 24h | Same status and body + `Idempotent-Replayed: true`; past 24h the failed row answers with the same status and code, and its message says to retry with a new key |
| 5xx, `serverErrors: "store"` | Yes, like Stripe | Replayed; retry with a new key |
| 5xx, `serverErrors: "rerun"` | No: unlocked, still bound to its fingerprint | A same-key retry runs again |
| 2xx and other 4xx | Yes, 24h | Same status and body + `Idempotent-Replayed: true` |

- A request that wrote its domain row has spent its key, whatever it answered: the retry gets the
  same answer, never a different one from the row (a 400 first, then a 200 `status: "failed"`). To
  try again after fixing the cause, send a new key. Recurring-payment attempts differ: their
  handlers never call `markIdempotencyCommitted`, a failed attempt is left out of their unique
  index, and the schedule returns to its prior state. What a same-key retry gets depends on how the
  failure was answered:
  - a 400, 401, 403, 409 or 429 (`TRANSACTION_FAILED`, `SIGNING_FAILED`, a state conflict) is not
    stored, so the retry runs the action again;
  - a 5xx is unlocked (`serverErrors: "rerun"`), so the retry runs the action again;
  - any other 4xx, such as a 422 `SIGNING_REJECTED` or a 404, is stored like any answer and
    replayed for 24 hours with `Idempotent-Replayed: true`. Only after the key expires does the same
    key run the action again, because the failed attempt row no longer answers it. To try sooner,
    send a new key.
- `serverErrors` is required: each route states which applies. `rerun` is only for a route whose
  handler writes its own row under a unique key before it moves anything and answers a retry from
  that row; every other route stores the 5xx.
- An error thrown past a caller that composes `runIdempotency` is stored only if it is an
  `AppError`, whose status is known. Any other error is mapped by the app's handler, so the key is
  unlocked and stays bound to its request instead of storing a guess.
- A success is never unlocked. A body over 1 MiB is stored without its body, and a bodyless status
  (204, 205, 304) replays without one.

**Lease.** 60 seconds by default, set per route, and renewed every third of the lease while the
handler runs. A crashed request's key frees when the lease runs out. A request still running after
15 minutes (`maxLeaseRenewalSeconds`) is treated as hung: renewal stops and logs
`sdp_idempotency_lease_renewal_cap`, so a retry can take over once the lease lapses. Statement and
signing timeouts end requests well before that.

**No bypass.** Every request on a route with the step goes through it. (Approved-operation
executions and Dry-Run skipped it until approvals and wallet policies were removed, HOO-1889.)

**Retention.** 24 hours. Expired rows are pruned hourly in-process and on every run of the managed
reconciliation job. A claim ignores an expired row. Unlocking marks a row released: a takeover can still claim it, and
it is not alerted on. A row still `in_progress` whose lease lapsed without a release when it is
pruned (`sdp_idempotency_unfinished_pruned`) or replaced by a new claim
(`sdp_idempotency_unfinished_replaced`) is a request that crashed before recording an outcome;
both log at error level for alerting.

**Declaration.** The step carries `Symbol.for("sdp.idempotency")` with its mode. `IdempotencyKeyMode`
lives in `@sdp/types`.

- A route mounts the step itself, directly after its `authorize` step. A future composite route
  declaration can call the exported `runIdempotency` in the same position.
- `authorize` carries `Symbol.for("sdp.authorize")`. When the route-declarations primitive lands,
  the markers become `RouteDeclaration.authorize` and `RouteDeclaration.idempotency`.

## Consequences

- A replay is only ever served to the credential that made the original request.
- Response bodies are stored in plaintext for 24h under forced RLS. Routes that return secrets
  never use the step; `routes/idempotency-route-exclusions.test.ts` pins API key and provider
  credential routes.
- Before a route takes accept mode, check its response for regulated data, such as counterparty
  bank details.
- A replay from this step returns the stored response, a snapshot: a transfer stored as
  `processing` replays as `processing`. A replay from the domain row (after a takeover, or past 24
  hours) returns the row's current state. Clients read the outcome with GET and never re-POST to
  learn it.
- Modules outside `stable` keep their own key handling until promoted. Their row fingerprints then
  become the backstop.
- `PATCH /v1/payments/recurring-payments/{id}` requires the key with the other money routes:
  editing an active schedule signs and broadcasts a replacement subscription.

## Follow-ups

- HOO-2044: recurring activation, lifecycle and update sends save their signature, signed
  transaction and blockhash window on the attempt before broadcast, so recovery confirms the saved
  signature instead of signing again.
- HOO-2045: split `requestGate` into `authorize`, `replayFromRecord` and admission on Earn,
  issuance and ramps.
- HOO-2046: stable routes validate path and query params at the route (the param sweep).
- HOO-2047: payment requests in the public OpenAPI document.
- Custody wallet create: an intent row before the provider call, for providers that do not dedupe
  on a request id (see "Two layers").
