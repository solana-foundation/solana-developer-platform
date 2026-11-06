# Earn docs audit

Reviewed 2026-11-06 on `earn-docs`, based on `605333dc3`. This is a source and
focused-test audit for documentation readiness, not production certification.

## Scope and delivery

- All 46 mounted Earn operations, their internal OpenAPI contracts, grants,
  environment and provider gates, and prospective public scope.
- Treasury custody signing and customer-signed Embedded Yield, from previews
  through durable intent, broadcast, reconciliation, and displayed holdings.
- Direct exits, provider orders, solver queues, operator redemptions, recovery,
  observed payouts, earnings, and missing live values.
- Dashboard integration snippets, backend proxies, and public docs generation.

Drafts live in `apps/sdp-docs/content/unpublished`. The ten guides cover the
overview, concepts, minimal Quickstart, complete deposit API flow, Treasury,
Embedded Yield, eligibility, withdrawals, reporting, and integration details.
The reference preview uses the existing page renderer and OpenAPI source;
internal-only operations carry an explicit notice.

All docs code fences use a shared shell. Language alternatives share one header
and Copy control; workflow stages and response statuses keep their own tabs.
Quickstart separates direct API requests from the dashboard's generated
Embedded Yield backend module. Query links select either path. Its HTTP helper
lives beside the first API step; expandable code remains complete in Markdown.
The full deposit guide provides cURL and TypeScript requests.

This branch changes documentation and authoring tools. SDLC tier: Standard
because it adds a generation/check workflow. No runtime authorization, signing,
provider, money movement, or publication gate changes are included.

## Verified boundaries

Every Earn route requires credentials and project scope. API keys carry
independent `earn.execute` and `earn.manage` grants; each implies `earn.read`.
Neither write grant implies the other. Customer positions are scoped to the
organization, exact project, and environment. Custody signing also checks
the selected wallet's scope.

The internal document covers all 46 routes. The prospective partner contract
covers 21: strategy discovery, deposit preview, and customer-wallet operations.
Treasury, Programs, cross-model movement history, and custody share
reconciliation remain internal. API reference publication must use the public
document, never the complete internal preview.

Sandbox uses devnet; production uses mainnet-beta. `fundable` answers the
cluster question only. An active row still needs offered provider capability,
organization access, live liquidity, and admission. Reads and exits do not
inherit new-deposit availability gates. A `providerReference` names an
instrument; it is not a general funding address.

Transaction amounts use exact decimal strings at mint precision. A non-null
slippage policy requires a live quote and floor; null does not mean a zero
floor. Kamino devnet deposits do not accept a share floor, and Kamino exits
reject `minAmountOut`. Preview blocking issues and live withdrawal options
decide what can be offered.

Atomic confirmation can finish foreground UI while reconciliation continues to
finality. Provider-order confirmation proves only its on-chain payment/share
leg. A solver request escrows shares; an operator redemption produces an
intermediate token. Only authenticated finalized fulfillment establishes the
queued payout. `closedOrUnknown` remains unresolved.

Unavailable shares, values, and earnings remain absent. A withdrawal's requested
share amount is not its observed token payout. Earnings cover currently held
positions and include the owner's whole live holding, including outside
transfers. They are not complete lifetime return or per-user accrual records.

## Findings left open

### Queued build expiry can erase independently broadcast intent

If a wallet broadcasts a signed queued request or cancellation directly, then
first submits to SDP after expiry, cleanup can already have deleted its
unconsumed build. Submission returns 404 before creating durable tracking,
leaving the reconciler without the request. Require signing without broadcast
and prompt SDP submission in integration guidance. The Critical remedy must
preserve and authenticate late signed intent.

Remediation is included in [PR #2807](https://github.com/solana-foundation/solana-developer-platform/pull/2807),
verified at `60647498c117de11142695f4f48514569f4f3dbf`. Both expiry cleanup
paths retain builds, and regression coverage recovers a finalized signed
request after cleanup. The PR remains open; previously deleted builds still
need operator recovery. Keep this release caveat until the fix is deployed.

Evidence:
`apps/sdp-api/src/db/repositories/earn-vault-withdrawal-requests.repository.ts`
(`cleanupExpiredExternalBuilds`, also cleanup in
`createExternalWalletTransaction`), and
`apps/sdp-api/src/services/earn/vault-queued-withdraw.service.ts`
(`requireExternalBuild`). Direct deposit and withdrawal submits preserve
authenticated signed intent after expiry; the old blanket rebuild advice was
incorrect and has been removed from guides and source OpenAPI descriptions.

### Provider-order completion remains an integration gap

The chain reconciler records `chain_finalized_at` and keeps provider orders
economically `confirmed`. Its completion path explicitly requires a future
authenticated provider integration. Do not promise that polling today will
complete these orders or admit an unoffered provider based on chain finality.

Evidence:
`apps/sdp-api/src/services/earn/vault-movement-reconciliation.service.ts`
(provider-order branches and future completion note),
`apps/sdp-api/src/services/earn/movement-settlement-wire.ts`, and
`packages/sdp-types/src/provider-access.ts` (WisdomTree has no admitted cluster).

### Dashboard repeat-deposit timestamp is misleading

Embedded Yield's "Last deposit" uses position `createdAt`, but repeated
deposits reuse the position. Use the latest deposit movement timestamp or
rename the column. Evidence: `embedded-yield-dashboard.tsx` in the dashboard's
`markets/earn` directory and `earn-movements.repository.ts` position upsert.

### Generated movement polling accumulates abort listeners

`waitForEarnMovement` adds an abort listener during each delay and does not
remove it when the delay completes. Reuse the cleanup pattern already present
in the queued-request poller. Evidence: `earn-integration-snippets.ts` in the
dashboard's `markets/earn` directory.

No money-path implementation was changed to resolve these findings. No Linear
issues or external comments were created by this audit.

## Publication gates

- PRO-2395 tracks content readiness and reviewer review.
- PRO-2038 owns launch publication.
- PRO-2406 and PRO-1872 require named security sign-off for promotion.
- `EARN_PUBLIC_SURFACE_PUBLISHED` remains false. Authored drafts also carry
  `module: earn`; normal builds do not read `content/unpublished`.
- Only `VERCEL_ENV=preview` with `VERCEL_GIT_COMMIT_REF=earn-docs` stages the
  partner guides and 21 prospective API operations. Treasury and Programs stay
  excluded. Preview discovery links use its own origin and OpenAPI download.

## Validation

- Dashboard and backend proxy focus: 43 files, 544 tests passed.
- API focus: seven suites, 57 tests passed, including contract parity,
  schemas, exit classification, movement actions, hydration, and queued exits.
- OpenAPI/reference focus: three suites, 90 tests passed, including opt-in
  Earn generation and SDK 501 examples. Overlaps the API focus.
- API typecheck and source OpenAPI Biome checks passed.
- Generated integration snippet focus: 13 tests passed.
- Direct Quickstart helper: TypeScript syntax and five mocked polling/pagination
  cases passed, including confirmation, failure, and invalid cursor handling.
- Docs: 132 tests, typecheck, prose, production build, and link checks passed
  (177 pages, 673 links, 22 external URLs).
- All 57 draft pages passed module gates, MDX/prose parsing, future links,
  and Markdown parity, including exact preservation of all 250 code examples.
  The private AI corpus includes all 57 pages once, with Earn's notice on each.
  The generated public build, OpenAPI, and AI resources contain no Earn drafts.
- Desktop and mobile private authoring previews passed; the diagram and guide
  cards retain their text and links in Markdown. All ten private guide pages
  return 200 with the Earn development notice.
- Browser checks passed for single-frame code shells, exact active-code copying,
  keyboard language selection, synchronized preferences, response tabs, and
  mobile overflow. No browser errors were observed.
- Both Quickstart query values, invalid/missing defaults, manual switching,
  fragment navigation, and the visible-path outline passed browser checks.
  Workflow panels have matching 24px top and bottom padding.
- The segmented path selector passed light/dark, keyboard-focus, and mobile
  checks. The live Markdown response and Copy page include all three helper
  exports, including polling and pagination, while the disclosure is closed.
- Live search found all 57 page titles and passed 138 endpoint queries. All 46
  operation IDs and METHOD/path queries rank first; bare paths rank within
  three results. Code-only signing identifiers and all four deposit-stage
  links work, including repeated same-page navigation.
- Branch preview: 16 guard, merge, origin, and staging tests passed. The built
  site passed 14 route checks, including internal-page 404s, search, Markdown,
  preview AI links, OpenAPI coverage, and noindex headers. Rebuilding with
  `VERCEL_ENV=production` cleared staging and returned 404 on seven Earn URLs;
  normal search, AI resources and public OpenAPI again excluded Earn.
- CI fixes: the docs Docker builder passed after adding its missing Earn
  package. The integration guide's 12 tests passed with the updated label.

API focused suites used normal aliases/setup with Testcontainers startup
omitted. Database-backed expired-submit tests were inspected, not run.
Browser wallet flows, live provider calls,
funded sandbox deposits/exits, mainnet swaps, sponsor signing, and provider
settlement were not run. They remain required release evidence.
