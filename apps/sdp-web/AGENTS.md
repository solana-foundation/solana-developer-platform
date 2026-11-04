<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project scope

New ramp provider UI follows `docs/contributing/ramp-provider-safety.md` with
the API integration. Show provider settlement as pending until chain delivery
is verified; never turn a provider webhook alone into completed UI state.

Poll with SWR by passing `refreshInterval` as an inline function each render,
`(data) => interval(data)`. SWR clears a pending poll only when the option
changes, so with a stable function, data that turns terminal through a
`mutate` or another hook on the same key still gets one more request. The
function sees only data SWR fetched, never `fallbackData`: a poll seeded by
the server reads that seed itself while it gets `undefined`. An inline
function restarts the timer on every render, so it suits a short watch that
stops on its own. A poll that never stops keeps a plain number, and a slow
poll on a page that re-renders faster than its cadence (a discovery list, a
live feed with an idle back-off) uses `useCadencedSWR` (`src/lib`), which
passes SWR a number derived from the last read so only a cadence change
restarts the timer.

The public pay page (`app/pay/[token]`) reads the API's `/pay/:token` on the
web server, whose one address every payer shares under the API's per-address
limit for link reads (20 a minute, counted apart from the wallet's
`/pay/:token/tx` requests). Anything that reads it again, like the page's
status watch, calls the API from the payer's browser instead, at the public
address from `findPublicSdpApiBaseUrl`: `SDP_API_BASE_URL` can name a host only
the web server resolves (`http://sdp-api:8787` in Docker).

Dollar totals come from `payments/payments-overview.utils.ts`:
`resolveTotalBalance` sums held rows only and is null when nothing held has a
price, `formatTotalBalance` shows that null as a dash, and
`UnpricedHoldingsHint` sits beside a total that leaves holdings out. Off
mainnet the API prices no mint, so SOL arrives unpriced on devnet. Value a
token by its market price or, for a well-known USD stablecoin, by its mint;
never by its symbol, since anyone can mint a "USDC".

Dashboard pages live under `app/(session)/dashboard/[projectId]/`, and the Project comes from the URL alone:

- Server code (pages, server actions, route handlers) calls `createSdpApiClient()`, `requestProjectId()` and `requestProjectHref(path)` from `@/lib/sdp-api`; they read the request's `x-project-id`, which `proxy.ts` sets from the URL. Keep signatures Project-free: no `projectId` parameters, no reads of the selection cookie.
- Browser calls to `/api/*` go through `dashboardRequest` / `dashboardFetch` (`@/lib/dashboard-fetch`).
- Links use `useProjectHref()` (client) or `requestProjectHref()` (server); route comparisons use `useDashboardPathname()`. `src/lib/dashboard-project-links.unit.test.ts` fails a literal `/dashboard/…` link or redirect target; bare `/dashboard` (choose a Project) is the one unscoped target.
- A missing page or an unmatched address inside a Project renders `[projectId]/not-found.tsx` in the shell; the `[...unmatched]` catch-all exists so unmatched URLs reach it instead of the root 404.
- The shell keys its page frame (header and content) by pathname, so a route change replaces the frame rather than moving it. Whatever a page adds to the header after it mounts must not change the header's height: a title mark is held by the route's `titleMark`, and controls a page portals into the tab row (`DashboardHeaderTabsTrailing`) get a placeholder in the route's skeleton.
- The shell sizes itself in `dvh` (`h-dvh`, `min-h-dvh`), never `h-screen`: a phone browser's `vh` is its height with the toolbars hidden, so a locked page (a flow's footer) sat under the toolbar.
- Tests mock with `vi.mock("next/navigation", () => import("@/test/next-navigation"))` and `vi.mock("next/headers", () => import("@/test/next-headers"))`; fixtures live in `src/test/`.

A button whose action is running takes `loading` and keeps its words: the
design-system button spins in place at its own width, so there is no "…ing"
label and no busy variant; `disabled` stays for a button that is not ready. A
test finds it by its words plus the spinner's ("Save Loading"), so match the
start of the name and assert `aria-busy`. jsdom still runs a loading button's
`onClick` (in a browser the button's `pointer-events-none` and Base UI's
Enter/Space handling stop the press), so a test shows a blocked press through
`aria-disabled`, not by clicking again. A test that ends with a transition
still pending holds every later one in its file (React 19 entangles async
transitions), so one stale assertion can fail the whole file. A flow's new
step fades in through `useStepFade` (`src/lib`), which `WizardFrame` applies
for every flow it frames; both it and `Modal`'s entrance come from
`@sdp/ui/motion` and stay off under reduced motion.

Run the unit suite on Node 24.22.1, the version CI pins. On Node 26 every test
that touches `localStorage` or `sessionStorage` fails with "Cannot read
properties of undefined (reading 'clear')", although `engines` allows it.

# Stage smoke

Pull-request CI never runs the `gcp-read-only` Playwright project (`playwright/tests/gcp-read-only-*.e2e.spec.ts`). It runs after each merge against the deployed stage dashboard, with whatever design flags Vercel serves there, and a red run holds the production API and web release until a later merge goes green. A change that renames something these specs select (a link's name, a heading) updates them in the same pull request; where the two designs differ, match both.
