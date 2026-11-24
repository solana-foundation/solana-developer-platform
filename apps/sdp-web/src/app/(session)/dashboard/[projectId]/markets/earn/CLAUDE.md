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
- BFF routes under `src/app/api/dashboard/markets/earn` forward the five core
  endpoints, including single-position reads. Shared operation proxies live under `api/dashboard/operations`.
  Preserve project, environment, auth and idempotency headers through the seam.
- `earn-data.ts` supplies shared discovery and position reads. Activity and
  outstanding exits use current operations.
  Do not add a second history model or obsolete API proxies.
- `earn-integration-snippets.ts` supplies every guide code tab and Copy all.
  Keep it on the same core contract as the application.

## Operations and recovery

Preparation never signs or broadcasts. `submit` returns 202 after durable
acceptance; workers request signatures, broadcast and track settlement. Keep
polling queued and active operations, including custody providers that require
a signature in another application. Read requests never trigger submission.
Only the operation open in the dialog is read every 2 s, and only while SDP is
moving it; activity rows and provider waits are read every 30 s beside the
15 s feed, so many pending rows stay under the dashboard's shared request limit.

The default activity view polls active work and the newest 50 history entries.
Older pages load on demand and keep their snapshot while expanded; Refresh
returns to the newest page. Retain a pending row until its existing detail poll
observes a terminal outcome, even if it leaves the active feed. Completion from
either feed or detail must refresh holdings. A recovery refreshes holdings and
cash observations without becoming withdrawal proceeds. Hastra releases report
no settled amount; current available wYLDS comes from the live position read.
Timestamp-only updates must not trigger another balance read.

Render `nextAction` explicitly: `submit`, `sign_transaction`, `select_option`,
`sign_in_provider`, `wait` or `refresh`. Selecting a withdrawal option
prepares its terms through version-bound refresh, followed by separate review
and submission. Only the API can decide whether a
message is safe to replace. A pending or uncertain provider outcome remains
`wait`. Refresh prepares new terms only before submission acceptance, for separate
review and submission. Definitively failed submissions stay terminal; a new
intent needs a new deposit or withdrawal request.

A queued exit that escrows every share drops its position from the holdings
table while the request stays open, expired included, and its operation stays
`wait`. Treasury passes those positions as `withdrawalRecovery`, so the settling
row offers Recovery options: the withdraw dialog with All selected, whose
preparation returns any recovery route or the API's refusal.

Persist retry keys before sending. A lost response retries the same request
and exact signed bytes. Wire amounts stay fixed across an ambiguous retry,
including an intermediate-token All amount; live quotes and balances cannot
change the retained request. Do not prepare another transaction because an RPC read
is missing or a signature expired. Show cancellation only when the API returns
`canCancel: true`. It discards an unsubmitted preparation. Once `/submit` has
been accepted, cancellation and refresh stay unavailable. Cancellation never
revokes an onchain transaction or a provider withdrawal request.

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
Show returned catalogue rows even when deposits are unavailable. Treasury rows
carry their reason; the Embedded Yield picker lists every strategy as a plain
option and says why the selected one can't be funded under it, code still
shown. Provider entitlement reads through `providerAccessRefusal`
(`src/lib/provider-availability.ts`, shared with ramps): a Treasury row that
is not entitled reads "Not on your plan", and Treasury says it once above the
table when no offered provider is entitled. The API owns provider surfacing and filtering. Display APY basis and
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

An amount in the strategy's own share mint reads as shares
(`formatShareAmount`); every other mint formats as itself, never as shares.
Only statuses `isSdpProgressOperationStatus` (`@sdp/types/operations`) names
pulse; provider settlement can take days and stays still.

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
