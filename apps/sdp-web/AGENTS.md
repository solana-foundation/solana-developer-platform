<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

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

Dashboard pages live under `app/dashboard/[projectId]/`, and the Project comes from the URL alone:

- Server code (pages, server actions, route handlers) calls `createSdpApiClient()`, `requestProjectId()` and `requestProjectHref(path)` from `@/lib/sdp-api`; they read the request's `x-project-id`, which `proxy.ts` sets from the URL. Keep signatures Project-free: no `projectId` parameters, no reads of the selection cookie.
- Browser calls to `/api/*` go through `dashboardRequest` / `dashboardFetch` (`@/lib/dashboard-fetch`).
- Links use `useProjectHref()` (client) or `requestProjectHref()` (server); route comparisons use `useDashboardPathname()`.
- Tests mock with `vi.mock("next/navigation", () => import("@/test/next-navigation"))` and `vi.mock("next/headers", () => import("@/test/next-headers"))`; fixtures live in `src/test/`.

# Stage smoke

Pull-request CI never runs the `gcp-read-only` Playwright project (`playwright/tests/gcp-read-only-*.e2e.spec.ts`). It runs after each merge against the deployed stage dashboard, with whatever design flags Vercel serves there, and a red run holds the production API and web release until a later merge goes green. A change that renames something these specs select (a link's name, a heading) updates them in the same pull request; where the two designs differ, match both.
