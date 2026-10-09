<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project scope

Dashboard pages live under `app/dashboard/[projectId]/`, and the Project comes from the URL alone:

- Server code (pages, server actions, route handlers) calls `createSdpApiClient()`, `requestProjectId()` and `requestProjectHref(path)` from `@/lib/sdp-api`; they read the request's `x-project-id`, which `proxy.ts` sets from the URL. Keep signatures Project-free: no `projectId` parameters, no reads of the selection cookie.
- Browser calls to `/api/*` go through `dashboardRequest` / `dashboardFetch` (`@/lib/dashboard-fetch`).
- Links use `useProjectHref()` (client) or `requestProjectHref()` (server); route comparisons use `useDashboardPathname()`.
- Tests mock with `vi.mock("next/navigation", () => import("@/test/next-navigation"))` and `vi.mock("next/headers", () => import("@/test/next-headers"))`; fixtures live in `src/test/`.
