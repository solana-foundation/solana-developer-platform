# Refresh design checks (B1-B9)

Dashboard checks for putting a module's pages on the 2026 refresh design.
`web/` = `apps/sdp-web/src/`, `dash/` = `web/app/dashboard/[projectId]/`,
`ui/` = `packages/sdp-ui/src/`. Visual values come from
`packages/sdp-design-tokens` (README: layers, the `refresh:` variant, page
column); structural taste comes from `.agents/skills/sdp-ui-designer` (its CSS
bundle is the pre-refresh prototype, so take its rules, not its values).

#2568 deleted the legacy design and its flags (`withLegacyDesign`,
`useNewDesign`, `DesignSwitch`, `new-design*`). There is no fork and no flag:
rewrite each page in place and add its route to the refresh scope in the same
PR. Production shows a module's refresh pages only once the module is in
production's release channel.

## Contents

- B1 Theme scope route
- B2 Header page config
- B3 Page composition: legacy to refresh map
- B4 Dialogs and wizards
- B5 Loading states and layout shift
- B6 Copy
- B7 Phone widths
- B8 API Playground tab
- B9 Tests, smoke specs and doc sync

## B1 Theme scope route

- **Condition:** each rewritten page's path matches a regex in `REFRESH_ROUTES`
  (`web/lib/theme-scope-routes.ts`), and siblings that keep the base design
  do not (DvP under `/dashboard/markets/dvp` is the standing example).
- **Verify:** scanner B1 evaluates `themeScopeForPath` for every `page.tsx`
  under the module and prints `refresh` or `BASE`.
- **Done:** every page reads `refresh`; `web/lib/theme-scope-routes.unit.test.ts`
  has a row per new path plus a negative row for each sibling that stays base;
  the route list in `packages/sdp-design-tokens/README.md` ("In the dashboard
  the shell sets the attribute") names the module. Every Earn redesign PR
  touched all three.
- **Today:** DvP (all pages), Rings and most of Private Channels (all but the
  connect form) are `BASE`; Issuance, Payments, Wallets and Earn are refresh.

## B2 Header page config

- **Condition:** the module's pages get a config from its area's function in
  `web/components/dashboard-header.tsx` (`get<Area>RoutePageConfig`; a Markets
  sub-module such as DvP is a set of branches in `getMarketsRoutePageConfig`,
  shared with Earn, and shares `markets-route-skeletons.tsx`,
  `markets-landing.tsx` and the `DashboardMarkets.*` copy). Comments that
  justify a centred title on a detail page predate the refresh: revisit them.
  - top-level pages: `titlePosition: "left"`, `contentWidthClass:
    REFRESH_PAGE_WIDTH` (`max-w-page`, 852 px; forms and settings use
    `max-w-flow`, 660 px);
  - sub-pages: `backAction: { href, label }` instead of an in-page Back button;
  - the page's one primary action as `headerAction` (link only; `capability`
    hides it from a viewer who would only reach a refusal; `download` for
    exports);
  - no `max-w-none` plus a module-owned `max-w-[90rem]` frame.
- **Verify:** scanner B2 prints the header lines that name the module; read the
  config function. Centered titles and `max-w-none` mark a base page.
- **Done:** header unit tests cover each path (Earn's are in
  `web/components/dashboard-earn-header.unit.test.tsx`).
- **Earn:** Markets rendered a centred "Markets" title and a full-width rule on
  every page with Earn's own 90rem frame; each page now has its own left title
  in the page column.

## B3 Page composition: legacy to refresh map

Rewrite the composition, keep data hooks and trackers single-copy.

| Legacy pattern | Refresh replacement |
|---|---|
| Bordered `Card` per section, cards inside cards | `RecordStack`, `RecordBlock`, `RecordRow`, `RecordLine`, `StateBand` (`web/components/refresh-record.tsx`) |
| Row of stat cards with big numbers (`text-[32px]`) | One hero figure in `text-amount` plus a stat or summary line (Payments' available balance, Earn's `EarnSummary` in `dash/markets/earn/earn-page-blocks.tsx`) |
| Grid of link cards, eyebrow labels, audience blurbs | `ActionTile` via `web/components/ui/action-tile.tsx` (link only), one short line each |
| Wide bordered tables with `minWidth: 52-72rem`, 7-8 columns, or `@solana/design-system/table` | Borderless `@sdp/ui/table` no wider than the page column, fewer columns, widths per breakpoint pinned by a layout test (`web/test/table-columns.ts`, `treasury-layout.unit.test.ts`) |
| Raw status strings or provider ids in badges | `@sdp/ui/status-text`; badges are status-only; provider names via `formatCustodyProviderName` and `WalletProviderMark` (`dash/custody/`) |
| Hand-built warning banners | `@sdp/ui/callout` |
| `ListEmptyState` inside a Card, marketing empty states | `@sdp/ui/list-empty-state` alone; the action sits in the empty state or the header, not both |
| Design-system `SegmentedControl` for view switches | `@sdp/ui/segmented-control`; page tabs stay underlined |
| Hover lift, shadows, glow, italics, uppercase tracking | Removed: quiet and institutional, no hero art |
| Arbitrary type and widths (`text-[11px]`, `max-w-[63rem]`) | Scale tokens (`text-body`, `text-meta`, `text-subheading`); layout widths only in rem when no token exists |
| Ad hoc `<dl>` summaries | `@sdp/ui/detail-list` (`DetailList`, `DetailRow`) |

- **Rules that still hold:** mono only on code; table bodies one style, no
  bold, sentence case; numbers tabular; actions inside their block; a row's
  read-only and role gates move with its actions.
- **Variants, not forks:** when a shared component looks different in refresh,
  add a `refresh:` variant; when structure differs, branch on
  `useThemeScope() === "refresh"`.
- **Verify:** scanner B3 (legacy layout leads, Card-wrapped sections, `+` count
  of refresh primitives). Rings and Private Channels show 69-72 Card hits each.
- **Done:** zero B3 leads on rewritten pages, or each remaining one justified
  (a layout width in rem with no token).

## B4 Dialogs and wizards

- **Condition:** `@sdp/ui/modal` (it re-stamps the theme scope for portaled
  content; `placement: "top"` keeps a multi-step dialog's top edge still as
  steps change height), one width per family of flows, progress through
  `@sdp/ui/wizard-step-progress` (its live region announces the step name),
  summaries through `@sdp/ui/detail-list`, warnings through `Callout`, status
  as words. Every control that changes the flow is disabled while a request is
  in flight. Enter continues an input step and never confirms a money step.
- **Money never truncates:** amounts use `DetailRow fit="figure"` (whole, one
  line, the label wraps); names use `wrap`.
- **Verify:** scanner B4 (hand-rolled overlays or steppers, `+` count of the
  three primitives).
- **Done:** tests pin Enter behavior on input vs review steps and the in-flight
  disabled state.
- **Earn:** a custom `bg-white text-black` stepper, 466 px vs 408 px dialogs
  that re-centred every step, phone amounts truncated, "Backing: klend"; all
  fixed by #2586 (`Modal` gained `placement`, `DetailRow` gained `fit`).

## B5 Loading states and layout shift

- **Condition:** each route has a `loading.tsx` whose skeleton draws the ready
  page's footprint (same column widths, same row heights, same groups), and
  loading and error states hold that footprint.
- **Verify:** measure CLS per width at 1440 and 390 with a `layout-shift`
  `PerformanceObserver` (buffered) on a cold load; clear the persisted SWR
  cache (`localStorage` keys `sdp.dashboard.cache.*`) first, or the page paints
  cached data and never shows its loading state. Scanner B5 flags leftover
  design-switch code.
- **Done:** CLS 0 at both widths, stated in the PR; skeleton unit tests share
  the layout constants with the page (Earn's `markets-route-skeletons.tsx`).

## B6 Copy

- **Condition:** new copy goes only in the English catalogs,
  `apps/sdp-web/messages/en/dashboard-<area>.json` or `shared.json` (DvP's copy
  sits in `dashboard-earn.json` under `DashboardMarkets.dvp`); other locales are
  written by the translation bot, and CI's Translation Catalog Policy refuses a
  PR that mixes both. `pnpm --filter sdp-web check:i18n` passes (never add new
  copy to `web/i18n/ui-copy-baseline.json`; move the module's existing baseline
  entries into the catalog while you are there). Copy names products, not ids
  ("Kamino Lend", not "klend"), and describes API keys by their grants (Read,
  Execute, Manage), never legacy scopes (`earn:read`).
- **Copy that promises behavior is a contract.** "Will be refused", "SDP covers
  the fee", "paid in about an hour": find the API path that does it, or change
  the copy. DvP's wrong-cluster warning promises a refusal the API does not
  make (architecture A15).
- **Verify:** `check:i18n` (needs an installed workspace); grep the module's
  catalog keys for `:read`, `:write`, raw ids and fixed API hosts.
- **Earn (still open):** "earn:read and earn:write" in the integration guide
  callout and snippets; the fee note "The custody wallet signs. SDP covers the
  network fee." reads as if the wallet pays.

## B7 Phone widths

- **Condition:** at 360-390 px no table scrolls inside a card, primary actions
  stay on screen, status reads under the primary value, long notes wrap inside
  a reserved slot so a later read does not shift the row.
- **Verify:** render the page in a harness with the real CSS at 390 and 900 px
  (or the live app) and screenshot both; check with fixture data when the local
  project holds no positions.
- **Done:** phone screenshots in the PR body.

## B8 API Playground tab

- **Condition:** Wallets and Payments pair an Overview tab with an API
  Playground tab (`playgroundHeaderTabs` in `dashboard-header.tsx`,
  `DashboardWorkspaceTabShell`). The tab needs the module's family in the
  playground catalog (`PlaygroundModule` in
  `apps/sdp-api/scripts/generate-playground-catalog.ts`), which reads the public
  OpenAPI document; the playground proxy 404s anything outside the catalog.
- **Verify:** scanner B8.
- **Done:** either the tab ships with the family, or the module's notes say why
  it is blocked (Earn: held from the public OpenAPI until PRO-2038).

## B9 Tests, smoke specs and doc sync

- Tests that pin legacy markup (column sets, widths, centred headers) are
  rewritten, not deleted; each refresh layout gets its own tests.
- `pnpm check:ui-flow-coverage`: every top-level dashboard section (the folder
  under `dash/`, so DvP and Earn share `markets`) needs a row in
  `docs/testing/ui-flow-matrix.md`. A row reading `GAP` means no end-to-end
  spec covers the section: a release-readiness lead (scanner B9 prints it).
- Stage smoke (`apps/sdp-web/playwright/tests/gcp-read-only-*.e2e.spec.ts`)
  runs after merge against stage; a renamed link or heading it selects is
  updated in the same PR, or the release is held.
- The module's `CLAUDE.md` files and `packages/sdp-design-tokens/README.md`
  describe the new structure in the same PR.
- `pnpm --filter @sdp/ui test` when a primitive gains a prop (`fit`,
  `placement`): other modules use it too.
