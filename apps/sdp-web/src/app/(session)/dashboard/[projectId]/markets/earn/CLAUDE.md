# Earn dashboard

Treasury and Embedded Yield share the core Earn API. New money uses
`/v1/earn/discovery`, `/positions`, `/deposit`, `/withdraw`, then the shared
`/v1/operations` lifecycle. Do not add product-specific write flows or restore
program creation and allocation configuration.

## Data and action seams

- `src/lib/earn-client.ts` is the typed HTTP client with an injected transport.
  `earn-response-schemas.ts` validates reads; shared operation schemas validate
  writes and polling. `earn-core-data.ts` owns dashboard transport and polling.
- `earn-core-action-modal.tsx` collects intent, shows current operation terms,
  then requires explicit submission. A funding swap and deposit are atomic.
- `earn-core-operations.tsx` shows requested and verified settled amounts
  separately. Queue acceptance or Solana submission never means payout.
- BFF routes under `src/app/api/dashboard/markets/earn` forward the four core
  routes. Shared operation proxies live under `api/dashboard/operations`.
  Preserve project, environment, auth and idempotency headers through the seam.
- `earn-data.ts` supplies shared discovery and position reads. Activity and
  outstanding exits use current operations.
  Do not add a second history model or obsolete API proxies.
- `earn-integration-snippets.ts` supplies every guide code tab and Copy all.
  Keep it on the same core contract as the application.

## Operations and recovery

Preparation never signs or broadcasts. `submit` returns 202 after durable
acceptance; workers handle signing, provider approval and submission. Keep
polling queued and active operations, including custody providers that require
approval in another application. Read requests never trigger execution.

Render `nextAction` explicitly: `submit`, `sign_transaction`, `select_option`,
`approve_in_provider`, `wait` or `refresh`. Selecting a withdrawal option
prepares its terms through version-bound refresh, followed by separate review
and submission. Only the API can decide whether a
message is safe to replace. A pending or uncertain provider outcome remains
`wait`. Refresh returns new terms for separate review and submission.

Persist retry keys before sending. A lost response retries the same request
and exact signed bytes. Do not prepare another transaction because an RPC read
is missing or a signature expired. Release a cancellation key after a validated
response so a later explicit request can act on a newly created queue record.
Cancellation acknowledgement does not prove an in-flight action stopped.

## Positions and balances

Use `discover=true` only with an explicit wallet ID or owner address. It adds
verified pre-existing holdings within the integrated catalogue; default reads
cover tracked positions. Preserve API coverage and unavailable-read metadata.
Discovered acquisition dates may be null. Unknown cost basis means unknown
earnings, never zero principal or profit equal to the imported balance.

Use paired position and funding-wallet refreshes after an operation obtains a
movement reference. Pass `afterMovementIds` into positions and retain the
returned minimum-slot read context until both snapshots succeed. Keep polling
single-flight and quiet. Missing shares or token value remain unavailable.
Use decimal strings and exact decimal helpers, never `Number` for money.

## Catalogue and availability

Strategy visibility, executability and wallet funding are separate decisions.
Show returned catalogue rows even when deposits are unavailable, with their
reason. The API owns provider surfacing and filtering. Display APY basis and
observation time; do not imply stale or unavailable APY is a current quote.
Provider-unconfigured reads degrade to a quiet notice. Inspect error codes,
not only HTTP status, when describing unavailable execution.

Only Solana addresses render. Render provider position labels as supplied.
Keep cluster checks and provider availability at the shared seam, including
mainnet strategies visible but unavailable to a sandbox project.

## UI rules

Use the existing release-channel segment gates and flags in
`src/flags/definitions.ts`; do not introduce environment-variable twins.
Edit English `messages/en/dashboard-earn.json` only. Translation updates land
separately.

Use `@sdp/design-tokens`, shared UI primitives and the established row, summary
and table blocks. Keep Inter, status as words and `tabular-nums` for numbers;
monospace is only for code. Use `EARN_TRANSACTION_MODAL_FRAME` for action
modals. Input steps are forms; money execution requires its own button and
never submits on Enter.

Keep loading, empty and error states at the ready layout footprint. Long names
wrap or clamp inside child spans; amounts remain whole. In a `DetailRow`, use
`fit="figure"` for amounts and `fit="wrap"` for names. Design-system `cn` joins
classes without Tailwind merging, so conflicting parent classes are unsafe.

## Checks

Use Vitest with a jsdom docblock for DOM tests. Mock the data/client seam and
cover review before execution, unknown outcomes, retries and refresh behavior.
Run the Earn and Treasury unit suites, web typecheck and Biome. Browser checks
require the app's built-in Browser; report when it is unavailable.

Local setup and RPC rules live in `packages/sdp-earn/CLAUDE.md`. Run SDP-owned
services locally; do not load shared runtime secrets for a local demo.
