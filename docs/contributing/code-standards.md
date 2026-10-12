# Code standards

Rules every change to this repo follows. Reviewers (human and Greptile) flag violations; cite the section when you do.

## Correctness

- **No fallbacks.** Required data fails loudly. Don't paper over missing values with `?? x`, `|| x`, `|| {}`, `|| []`, optional chaining on data that is always present, default parameters, or a `try/catch` / `.catch(() => …)` that swallows the error and returns a default. Tests included: a swallowed setup error hides every failure behind it. No "shouldn't happen" guards. If a fallback is genuinely needed, justify it in the PR.
- **Tighten types, not runtime guards.** A guard or ternary that defaults one arm of a union means the type is too loose. Fix the callers and delete the dead arm.
- **Read single-valued inputs where the decision is made.** A deployment constant, a stage table, or the request's project is read at the point of decision, not threaded through every call. Tests swap it with `vi.mock` / `vi.spyOn`.
- **Gate at the choke point.** A rule lives inside the one function every path already passes through (factory, store write, middleware), and it refuses before any state check or 4xx a loader raises. Any read that reports the same rule (availability, eligibility) calls that gate's decision function, so the two can't disagree. "Call X at every entry point" is the smell.
- **Related DB writes share one transaction.** Never sequential autocommits that can leave a partially created aggregate. `db.transaction(cb)` plus the executor adapter in `apps/sdp-api/src/db/client.ts` let existing repositories run inside the transaction.
- **No hand-rolled money math.** Decimal amounts go through `@sdp/payments/decimal` (`sumDecimalAmounts`, `compareDecimalAmounts`, …) and base-unit conversion through `@sdp/solana/amount`. Never a bare `reduce` over amount strings. Exact `bigint` lamport arithmetic is fine. Missing an operation? Add it to `@sdp/payments/decimal`.
- **Prefer native environment signals.** `NODE_ENV` (and framework equivalents) distinguish development mode from production mode, not local runs from deployed runs. Local containers can run in production mode. Use the signal that matches the decision, and check existing configuration before adding a new gating variable.
- **Reuse before you add.** Search the shared modules for an existing helper before writing one; new code goes where similar code lives.
- **Prefer `@solana/kit` and Mosaic** over hand-rolled transaction, account, token, codec, or RPC code.

## Concurrency on money and external-spend paths

Every path that moves money or spends with a third party enumerates its interleavings before code is written: the same idempotency key concurrently, the same key with a different payload, no key, a crash between each durable step, a definitive rejection, an ambiguous timeout, a background reconciler racing the request, and a retry after failure. Solve them with idempotency fingerprints and database constraints, not locks or timing.

- **Claim before spend.** A unique-index `INSERT` decides the race before any fee-payer signature, provider call, or broadcast. The loser returns the winner's row having spent nothing.
- **Compare-and-set every transition:** `WHERE status = <the state it was computed from>`.
- **Release reservations deterministically** when a transaction is definitively not broadcast (`prepareOwnedSubmission` + `releaseDefinitelyUnbroadcast`). Never a bare `signAsFeePayer` on a path that can fail to send.
- **RPC acceptance is not confirmation.**
- **Every intermediate state has a terminal rule.**
- **Claimed fields are immutable.** A value written as part of a claim (residence country, provider reference, currency, destination) is first-write-wins in SQL (`WHERE x IS NULL`, or a merge where stored keys win). A later request naming a different value gets a `409 conflict()` before any provider call. Never a silent overwrite, never "latest wins".

## TypeScript

- No `any`. `unknown` only at genuine trust boundaries, narrowed immediately. No casts to get past the checker.
- Finite sets use `as const satisfies Record<string, ValueType>`, never `enum` or `Record<string, string>`. Genuinely open JSON is `Record<string, unknown>`; an interface with an index signature only when known fields coexist with an open extension.
- Variant data uses `z.discriminatedUnion` (not `z.union`), and the type is derived with `z.infer`, never written by hand alongside it.
- **Status sets and their meanings live once, in `@sdp/types`.** A tuple `X_STATUSES as const` with its derived type, and every subset or predicate (terminal, in-flight, editable, transition tables) exported beside it, as in `RAMP_TRANSFER_STATUS_TERMINAL` / `isTerminalRampTransferStatus`. Never a local `const TERMINAL = [...]`, `new Set([...])`, `=== "a" || === "b"`, or SQL `IN ('a', 'b')` in a service, repository, component, or test. Migrations and single-status assignments are the only exceptions.
- Never a plain `string` where an `@sdp/types` constant set exists. Scripts import canonical types from `@sdp/types`. ISO codes are uppercase.
- Parsed webhook events are fully typed: exact shapes and a discriminated union per event type, never `unknown` or `Record<string, unknown>`. Raw webhook bodies may use these types while runtime readers or schemas check them at the trust boundary.
- Three or more branches use a `switch` with an exhaustive `never` default, not nested ternaries.
- No top-of-file `/** */` docstrings. Function and method JSDoc is fine.
- Token mints and labels come only from `@sdp/types/well-known-tokens` (`WELL_KNOWN_TOKENS`, `WELL_KNOWN_TOKEN_BY_MINT`, `SOL_MINT`, `wellKnownMint`, `CLUSTER_BY_SDP_ENVIRONMENT`). Never hardcode a mint address or a symbol mapping elsewhere.

## API (`apps/sdp-api`)

- A new resource is its own module: repository, `schemas.ts`, and handlers/route under `routes/<resource>/`. Child resources too: mount under the parent (`counterparties.route("/:counterpartyId/accounts", accountsApp)`), but never add the child's methods or schemas to the parent's files.
- Provider-specific code (request builders, mappers, id generators) lives in provider files; handlers keep orchestration and database access only.
- **Soft delete only:** `status = 'archived'` with partial indexes on active rows. No hard-delete paths or indexes built for cascade deletes. New tables get a `status` column with a `CHECK`; keep `ON DELETE CASCADE` foreign keys as correctness insurance, just don't index for them.
- Child-table repository methods are scoped by parent id: get, update, and archive as well as list. Cover it with a cross-parent test (wrong parent id returns null and leaves the row untouched).

### Ramp providers

- One directory per provider at `packages/sdp-payments/src/ramps/providers/<id>/`: `client.ts` (HTTP only: auth, signing, parsing; no database or `AppContext`), optional `counterparty.ts` (present only when requirements are non-trivial), optional `provider-data.ts` (JSON codecs).
- No webhook code in the package. Payload types, parsers, and the `WebhookProcessor` live in `apps/sdp-api/src/routes/webhooks/ramps/<id>.ts`, registered in `routes/webhooks/handlers.ts`, and map to `RampSettlementEvent`. Parsers use the `@sdp/payments/json` readers, never hand-rolled narrowing.
- Provider instances come only from `RAMP_PROVIDER_CLIENTS`. A second instance breaks the webhook tests' `vi.spyOn` mocks.
- Provider clients never access the database. Route handlers and background jobs access it through repositories.

## Dashboard (`apps/sdp-web`)

- Reusable UI behavior is a hook holding the logic plus a component (like `ArrowPagination`), never inline state or slicing in the page or table.
- Multi-field forms use `useZodForm` with per-step zod schemas. Raw `useState` only for non-form UI state. Dynamic field sets that need per-render validity use a controlled map (`useZodForm.validate()` is imperative and mutates error state).
- No `useEffect` for derived or reset state: derive during render, and reset with a component `key` or the store-previous-value-during-render pattern.
- Every control that changes the flow (mode pickers, Back, step navigation) is disabled while any request is in flight, including a child form's: the parent derives one in-flight value from every form's `onPendingChange`.
- SWR: turn the `revalidate*` options off when the data can't change during the session.
- Tailwind: scale tokens only (`text-2xl`, `tracking-tight`), no arbitrary values (`text-[28px]`); convert one-offs when you touch them. Layout dimensions with no token may stay arbitrary, in rem (`h-[40rem]`) rather than px.
- Design-system input and select states use the CSS variables from `@solana/design-system`: `bg-[var(--input-bg-idle)]` / `-hover`, `border-[var(--input-border-idle)]` / `-focus`, and focus ring `shadow-[0_0_0_2px_var(--input-focus-ring)]`.
