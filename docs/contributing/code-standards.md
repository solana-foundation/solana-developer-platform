# Code standards

Rules every change to this repo follows. Reviewers (human, Greptile, and the `sdp-review` skill) flag violations; cite the section when you do.

## Correctness

- **No fallbacks.** Required data fails loudly. Don't paper over missing values with `?? x`, `|| x`, `|| {}`, `|| []`, optional chaining on data that is always present, default parameters, or a `try/catch` / `.catch(() => …)` that swallows the error and returns a default. A defaulted `{}` flowing into an all-optional schema or a spread is the worst case: it turns a dropped payload into a silent 200 no-op. Tests included: a swallowed setup error hides every failure behind it. No "shouldn't happen" guards. Mapping an optional field to an explicit `null` (`input.memo ?? null`) is fine. If a fallback on required data is genuinely needed, justify it in the PR.
- **Tighten types, not runtime guards.** A guard or ternary that defaults one arm of a union means the type is too loose. Fix the callers and delete the dead arm.
- **Read single-valued inputs where the decision is made.** A deployment constant, a stage table, or the request's project is read at the point of decision, not threaded through every call. Tests swap it with `vi.mock` / `vi.spyOn`.
- **Gate at the choke point.** A rule lives inside the one function every path already passes through (factory, store write, middleware), and it refuses before any state check or 4xx a loader raises. Any read that reports the same rule (availability, eligibility) calls that gate's decision function, so the two can't disagree. "Call X at every entry point" is the smell.
- **Related DB writes share one transaction.** One logical state transition is one `db.transaction(cb)`: its invariant reads and every create, update, archive, audit, and outbox write. Pass the same transactional client through every callee (the executor adapter in `apps/sdp-api/src/db/client.ts` lets existing repositories run inside it) and never mix it with the root client. Failures escape so the transaction rolls back; catching a failed write and continuing is a violation. Provider and RPC calls can't roll back, so they sit behind an idempotent staged state or outbox. A failure-path test proves a mid-sequence failure rolls back every write. Every query stays scoped by the authenticated tenant or parent id.
- **No hand-rolled money math.** Decimal amounts go through `@sdp/payments/decimal` (`sumDecimalAmounts`, `compareDecimalAmounts`, …) and base-unit conversion through `@sdp/solana/amount`. Never a bare `reduce` over amount strings. Exact `bigint` lamport arithmetic is fine. Missing an operation? Add it to `@sdp/payments/decimal`.
- **Prefer native environment signals.** `NODE_ENV` (and framework equivalents) distinguish development mode from production mode, not local runs from deployed runs. Local containers can run in production mode. Use the signal that matches the decision, and check existing configuration before adding a new gating variable.
- **Reuse before you add.** Before writing a helper, search the shared modules, `@sdp/*` packages, installed dependencies, and the standard library; date/currency formatting, id generation, and retry/dedupe logic almost always exist already. New code goes where similar code lives.
- **Prefer `@solana/kit` and Mosaic** over hand-rolled transaction, account, token, codec, or RPC code: Kit's branded types, codecs, commitment comparison, transaction size checks, and typed RPC methods over hand-written commitment ordering, packet-size constants, raw JSON-RPC payloads, Solana-specific base64 conversion, signer-shaped casts, or `as Address` / `as Signature`. Compare against the Kit version pinned here; an API that exists only in a newer release is an upgrade candidate, not a new dependency. An `@sdp/*` wrapper earns its place only by adding SDP behavior (transports, retries, observability, tenant policy, provider normalization, persistence, idempotency).

## Concurrency on money and external-spend paths

Every path that moves money or spends with a third party enumerates its interleavings before code is written: the same idempotency key concurrently, the same key with a different payload, no key, a crash between each durable step, a definitive rejection, an ambiguous timeout, a background reconciler racing the request, and a retry after failure. Solve them with idempotency fingerprints and database constraints, not locks or timing.

- **Claim before spend.** A unique-index `INSERT` decides the race before any fee-payer signature, provider call, or broadcast. The loser returns the winner's row having spent nothing.
- **Compare-and-set every transition:** `WHERE status = <the state it was computed from>`.
- **Release reservations deterministically** when a transaction is definitively not broadcast (`prepareOwnedSubmission` + `releaseDefinitelyUnbroadcast`). Never a bare `signAsFeePayer` on a path that can fail to send.
- **RPC acceptance is not confirmation.**
- **Every intermediate state has a terminal rule.**
- **Claimed fields are immutable.** A value written as part of a claim (residence country, provider reference, currency, destination) is first-write-wins in SQL (`WHERE x IS NULL`, or a merge where stored keys win). A later request naming a different value gets a `409 conflict()` before any provider call. Never a silent overwrite, never "latest wins".

## Platform obligations

A change that triggers one of these must handle it.

- **Allowed Operations coverage.** An operation that moves value or signs is declared with `requireAllowedOperation` (`apps/sdp-api/src/middleware/allowed-operations.ts`) using a type from `OPERATION_TYPES` (`packages/sdp-types/src/allowed-operations.ts`), and the route inventory test pins it. One that fits no type needs a new type (and its family), not a shoehorn. A change to what an existing operation means must say whether keys' `allowedOperations` lists still say what they intended. Exits that return funds (cancel, reclaim) stay ungated on purpose.
- **Idempotency coverage.** A POST/PATCH/PUT/DELETE route in a `stable` module (or any route that moves money) runs validation, then `authorize(fn)` from `apps/sdp-api/src/middleware/authorize.ts` (or `authorizeNone(reason)`), then `idempotent({ key, serverErrors })` from `apps/sdp-api/src/middleware/idempotency.ts`, then replay from the domain row and admission, then the handler. Money-moving routes use `key: "required"`; `serverErrors: "rerun"` only where the handler writes its own unique-key row first and answers a retry from it. Violations: an access check left in a handler or after `idempotent()`; a state check (resource active, request pending) inside `authorize`; a handler that is not re-entrant after a takeover (signs or sends twice, or 409s on a request that already succeeded); an external call with no intent row first on a `rerun` route; a route that mounts `replayFromRecord` without `recovery: "record"` on its `idempotent()` step; a new direct read of the `Idempotency-Key` header or a new per-module replay table; the step on a route whose response carries a secret; or a dashboard/BFF mutation that does not send or forward the key. See `docs/decisions/0009-idempotency-keys.md`.
- **Money admission.** Anything that starts new money movement is admitted against the organization's live state (`apps/sdp-api/src/lib/money-admission.ts`, `docs/decisions/0007-money-admission.md`). A flow that signs names its own module's movement from `MOVEMENTS` (`packages/sdp-types/src/movements.ts`) when it resolves the custody signer or fee sponsor, which decide at signing time; borrowing another flow's id, an exit above all, bypasses admission. A start that signs nothing (a provider quote, session, or payout) or runs without an authenticated actor (a job, `/pay`) calls `assertMoneyStartAdmitted` before its first provider call or new signature. Signers come only from the custody signer and fee sponsor; `pnpm check:value-movement` pins the constructors. Exits and confirm-only work never ask. Adding an exit, or turning a start into one, needs a named security reviewer.
- **Encryption at rest.** Credentials, key material, and sensitive provider data round-trip through the KMS-backed crypto (`apps/sdp-api/src/lib/gcp/kms-client.ts`; `lib/spc-credential-crypto.ts` is the pattern), never a plaintext column. SSN, CDD, and bank details are never persisted: pass them through to the provider just in time.
- **Kora budgets.** Anything new that Kora sponsors (fees, ATA rent, a new sponsored instruction) is admitted and debited through `apps/sdp-api/src/services/sponsorship-budget.service.ts`.
- **Metered quota.** A route that costs real money or provider calls (signing, provider-backed, RPC-heavy) mounts behind `meteredQuota` (`apps/sdp-api/src/middleware/metered-quota.ts`) like the existing paid routes.
- **Release-channel gating.** A nav item, tab, filter, chip, or option list naming SDP modules or ramp providers comes from the channel-capped flags (`enabledTransactionModules(flags)`, `getEnabledRampProviders()`, `isModuleInDeploymentReleaseChannel`), never a raw tuple from `@sdp/types` or a copied list. A `*.redesign.tsx` page keeps its legacy twin's gating. A new API route sits behind `requireModule`. CI runs `experimental`, so a gating test renders with stable-capped flags. See `docs/decisions/0005-release-channels.md`.

## TypeScript

- No `any`. `unknown` only at genuine trust boundaries, parsed immediately: never an `unknown` parameter (except `cause`) or return type. No casts to get past the checker; any assertion other than `as const` carries a `SAFETY:` comment, and never chain assertions or widen a const to assert it narrower.
- **External input is parsed with zod at the boundary:** route bodies, params, and queries, webhook payloads, provider responses, and env at startup. Hand-rolled `typeof` / `in` narrowing, `Reflect.get`, `JSON.parse` casts, and `as`-typed payloads are violations.
- Finite sets use `as const satisfies Record<string, ValueType>`, never `enum` or `Record<string, string>`. Genuinely open JSON is `Record<string, unknown>`; an interface with an index signature only when known fields coexist with an open extension.
- Variant data uses `z.discriminatedUnion` (not `z.union`), and the type is derived with `z.infer`, never written by hand alongside it.
- **Status sets and their meanings live once, in `@sdp/types`.** A tuple `X_STATUSES as const` with its derived type, and every subset or predicate (terminal, in-flight, editable, transition tables) exported beside it, as in `RAMP_TRANSFER_STATUS_TERMINAL` / `isTerminalRampTransferStatus`. Never a local `const TERMINAL = [...]`, `new Set([...])`, `=== "a" || === "b"`, `.includes("x")`, or SQL `IN ('a', 'b')` in a service, repository, component, or test, even when typed against the canonical union. Migrations and single-status assignments are the only exceptions.
- Never a plain `string` where an `@sdp/types` constant set exists. Scripts import canonical types from `@sdp/types`. ISO codes are uppercase.
- Three or more branches use a `switch` with an exhaustive `never` default, not nested ternaries.
- No conditional empty-object spreads (`...(cond ? { x } : {})`), no parameters typed as bare `object`, and no "shape" in symbol names.
- **Imports name the defining file** (`docs/decisions/0010-module-boundaries.md`). No barrels or re-exports (`export … from`, or importing a symbol only to export it again); a package's public surface is its `package.json` `exports` list. No default exports outside framework-read files. No `../` imports: `@/` in an app, `#/` inside a package, `@sdp/<pkg>/<subpath>` across workspaces; same-folder `./` is fine.
- Token mints and labels come only from `@sdp/types/well-known-tokens` (`WELL_KNOWN_TOKENS`, `WELL_KNOWN_TOKEN_BY_MINT`, `SOL_MINT`, `wellKnownMint`, `CLUSTER_BY_SDP_ENVIRONMENT`). Never hardcode a mint address or a symbol mapping elsewhere.

## Tests

- Module mocking (`vi.mock`) is for single-valued ambient inputs only: deployment constants, release-stage tables, the request's project. Everything else is injected through real interfaces or swapped with `vi.spyOn` on the shared instance.

## Dependencies

- Registry dependencies use exact versions, no ranges or moving tags (`pnpm check:pinned-dependencies`); `workspace:*` and `catalog:` are fine. A new dependency needs a reason a few lines of code can't cover.
- A `package.json` change removes the dependencies it made unused.
- External `uses:` references in `.github/workflows/**` pin a full 40-character commit SHA with the release tag in a trailing comment. Local `./` actions are exempt.

## API (`apps/sdp-api`)

- A new resource is its own module: repository, `schemas.ts`, and handlers/route under `routes/<resource>/`. Child resources too: mount under the parent (`counterparties.route("/:counterpartyId/accounts", accountsApp)`), but never add the child's methods or schemas to the parent's files.
- Provider-specific code (request builders, mappers, id generators) lives in provider files; handlers keep orchestration and database access only.
- **Soft delete only:** `status = 'archived'` with partial indexes on active rows. No hard-delete paths or indexes built for cascade deletes. New tables get a `status` column with a `CHECK`; keep `ON DELETE CASCADE` foreign keys as correctness insurance, just don't index for them.
- Child-table repository methods are scoped by parent id: get, update, and archive as well as list. Cover it with a cross-parent test (wrong parent id returns null and leaves the row untouched).

### Ramp providers

- Follow [`ramp-provider-safety.md`](ramp-provider-safety.md) for immutable
  quotes, durable webhook replay, chain-verified completion, recovery, and
  required sandbox evidence. Provider `settled` is not transfer `completed`.
- One directory per provider at `packages/sdp-payments/src/ramps/providers/<id>/`: `client.ts` (HTTP only: auth, signing, parsing; no database or `AppContext`), optional `counterparty.ts` (present only when requirements are non-trivial), optional `provider-data.ts` (JSON codecs).
- The package defines the optional provider webhook contract but contains no
  webhook handlers. Payload schemas, parsers, and processors live in
  `apps/sdp-api/src/services/ramps/webhooks/<id>.ts`, with ingress in
  `routes/webhooks/handlers.ts`. Parsers `safeParse` a zod
  `z.discriminatedUnion` per event type; unknown event types map to `ignore`.
- Provider instances come only from `RAMP_PROVIDER_CLIENTS`. A second instance breaks the webhook tests' `vi.spyOn` mocks.
- Provider clients never access the database. Route handlers and background jobs access it through repositories.

## Dashboard (`apps/sdp-web`)

- Reusable UI behavior is a hook holding the logic plus a component (like `ArrowPagination`), never inline state or slicing in the page or table.
- Multi-field forms use `useZodForm` with per-step zod schemas. Raw `useState` only for non-form UI state. Dynamic field sets that need per-render validity use a controlled map (`useZodForm.validate()` is imperative and mutates error state).
- No `useEffect` for derived or reset state: derive during render, and reset with a component `key` or the store-previous-value-during-render pattern.
- Every control that changes the flow (mode pickers, Back, step navigation) is disabled while any request is in flight, including a child form's: the parent derives one in-flight value from every form's `onPendingChange`.
- SWR keys, for `useSWR`, `useSWRMutation`, and global `mutate(...)`, come from the feature's colocated query-key factory (`payments/payments-query-key.ts`, `custody/custody-query-key.ts`, …), never an inline string or array. Conditional gating (`cond ? key : null`) stays at the call site.
- SWR: turn the `revalidate*` options off when the data can't change during the session.
- Tailwind: scale tokens only (`text-2xl`, `tracking-tight`), no arbitrary values (`text-[28px]`); convert one-offs when you touch them. Layout dimensions with no token may stay arbitrary, in rem (`h-[40rem]`) rather than px.
- Design-system input and select states use the CSS variables from `@solana/design-system`: `bg-[var(--input-bg-idle)]` / `-hover`, `border-[var(--input-border-idle)]` / `-focus`, and focus ring `shadow-[0_0_0_2px_var(--input-focus-ring)]`.
