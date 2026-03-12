# Layout System

The dashboard now uses composable layout primitives instead of a route-aware shell.

## Architecture

- `AppShell`: top-level split layout with sidebar slot and rounded content frame
- `PageLayout`: width scope that keeps headers and bodies on the same horizontal grid
- `DashboardSidebar`: Clerk-aware sidebar wrapper around `SidebarNav`
- `DashboardSidebarTrigger`: open-sidebar control shown when the sidebar is collapsed
- `DashboardAuthGuard`: handles loading, signed-out, and no-organization states
- `PageHeader`: page-level header for title, actions, tabs, and back links
- `PageBody`: scrolling body container with width presets or full-bleed fill mode

Declare width once with `PageLayout` so wide/narrow headers, tabs, back links, and body content share the same horizontal grid. The `display` header variant uses shell-level inset tokens instead.
Sidebar width, shell gutter, nav row density, and header insets are defined by layout tokens in `src/styles/solana-design-system.css`; shared layout primitives should consume those tokens instead of hard-coded spacing classes.

## Page Pattern

Most routes should render:

```tsx
<PageLayout width="full">
  <PageHeader variant="wide" title="Page title" />
  <PageBody>{/* page content */}</PageBody>
</PageLayout>
```

Available header variants:

- `display`: shell-level inset and large top spacing for landing-style pages like Home
- `wide`: full-width dashboard list pages
- `narrow`: detail, setup, and settings pages

Available page widths:

- `narrow`: `max-w-3xl`
- `default`: `max-w-5xl`
- `wide`: `max-w-7xl`
- `full`: unconstrained width

Use `fill` when the page content needs to own the full remaining viewport without inner padding:

```tsx
<PageLayout width="full">
  <PageHeader variant="wide" title="Payments" tabs={<PaymentsTabs />} />
  <PageBody fill>
    <ApiPlayground />
  </PageBody>
</PageLayout>
```

## Tabs And Playground Mode

Tabbed pages such as Issuance and Payments render tabs in `PageHeader`, but the active tab lives in the workspace component via `useDashboardWorkspace()`. The page sets width once with `PageLayout`, and nested `PageBody` instances inherit it automatically.

- Overview tabs should render `PageBody`
- API playground tabs should render `PageBody fill`

This keeps the page-level header static while the workspace controls whether the content area scrolls or stays full-bleed.

## Scroll Model

- `AppShell` owns the full viewport height
- `PageHeader` stays at the top of the content column
- `PageBody` is the scrolling region for standard pages
- `PageBody fill` disables the padded scroller so embedded shells can manage their own height

## Sidebar Density

- `SidebarNav` uses section metadata to control row density
- `Create` keeps the default 8px row rhythm
- `Manage` uses a compact 4px row rhythm to match the shared Figma nav component
- Bottom utility links reuse the default nav row rhythm

## Validation Surface

- Validate shared layout changes against the live dashboard routes that use each header and body variant

## Adding A New Dashboard Page

1. Pick the correct `PageHeader` variant from the existing route patterns.
2. Pick the correct `PageLayout` width and use `PageBody fill` only for full-bleed embedded shells.
3. Keep route-specific actions in the page file, not in a central shell.
4. If the page needs tabs, render them in `PageHeader` and let the workspace own the body mode.
5. Reuse `DashboardWorkspaceProvider` state only for shared dashboard concerns such as sidebar and tab state.
