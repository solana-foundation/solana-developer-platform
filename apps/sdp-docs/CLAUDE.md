# sdp-docs — Design System & Page Guidelines

## Stack

- **Next.js 16** (App Router) + **Fumadocs** (`fumadocs-core`, `fumadocs-ui`) for the docs framework
- **Tailwind v4**, imported at the top of `src/app/globals.css`; `dark:` follows the `.dark` class the theme switch sets
- **`@sdp/design-tokens`** for every color, type size, radius, control height, motion value and font, so the docs match the dashboard's refresh design. `globals.css` imports `tokens.css` and `theme.css`; `<html>` carries `refreshThemeProps`
- **Custom CSS** in `src/app/globals.css`: all layout classes are prefixed `launch-docs-*`
- **Lucide React** for icons
- **Docker image**: `Dockerfile.dockerignore` drops `packages/*` except an allowlist, so a new workspace dependency needs its own `!packages/<name>` line (and its `COPY` lines in the `Dockerfile`), or the image build fails with `not found`

---

## Fonts

`src/app/layout.tsx` loads the refresh faces from `packages/sdp-design-tokens/src/assets/fonts` with `next/font/local`, as sdp-web does, under the variable names `tokens.css` reads:

| Variable      | Font                                           | Usage                                        |
| ------------- | ---------------------------------------------- | -------------------------------------------- |
| `--font-sans` | Season Sans 400 and 500 (`--font-season-sans`) | All text: body, headings, nav, labels        |
| `--font-mono` | Geist Mono, variable (`--font-geist-mono`)     | Inline code, code blocks, the `.env` preview |

Season Sans ships 400 and 500 only, so cap `font-weight` at 500. `html` sets `font-synthesis-weight: none` so the browser never fakes a bold, and `strong`, `b` and `th` are 500 inside `.sdp-docs-shell`.

---

## Color Tokens

The docs keep no palette of their own: read the refresh tokens from `packages/sdp-design-tokens/src/tokens.css`. Light values sit on `:root` and dark on `:root.dark`, so one rule covers both modes. Never hardcode a color; a missing token goes in the package.

| Token                                           | Use for                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `--paper`                                       | page background                                                            |
| `--paper-side`                                  | sidebar                                                                    |
| `--paper-card`                                  | cards, tables, popovers                                                    |
| `--paper-tile`                                  | table headers, badges, muted fills                                         |
| `--ink`                                         | headings, links, strong text, the active nav item                          |
| `--ink-secondary`                               | body text, nav items, breadcrumbs                                          |
| `--ink-tertiary`                                | captions, section labels, icons, list markers, link underlines             |
| `--rule` / `--rule-strong` / `--rule-faint`     | default borders / emphasis (step chips, blockquotes) / hairline separators |
| `--wash` / `--wash-strong` / `--wash-strongest` | hover fill / active nav item and inline code / pressed or selected         |
| `--chip` + `--chip-ring`                        | raised controls: sidebar actions, the `⌘K` keys, the mobile menu button    |
| `--positive`, `--critical`                      | status only (the Devnet dot, form errors)                                  |

### Fumadocs bridge tokens

Fumadocs components read `--color-fd-*` vars. One `:root` block in `globals.css` points them at the refresh palette (`--color-fd-background: var(--paper)`, `--color-fd-card: var(--paper-card)`, …). Change colors in `@sdp/design-tokens`, never in the bridge.

### Motion

Transition durations and easing come from the package: `--motion-duration-fast` (120ms) for hover and press feedback, `--motion-duration-base` (180ms) for a small reveal, `--motion-duration-slow` (240ms) for a panel, with `--motion-ease-out`. They drop to 0ms under `prefers-reduced-motion`. Every transition in `globals.css` reads them; use them for new hover, press or reveal motion instead of a raw `ms` value.

---

## Layout Structure

```
<div class="sdp-docs-shell">           ← min-height 100vh, --paper bg
  <DocsSidebar />                      ← 320px fixed left, --paper-side bg
  <main class="launch-docs-main">      ← margin-left: 320px on desktop
    <div class="launch-docs-main-inner"> ← max-width 1120px (1240px at 1180px+), centered, padded
      <DocsBreadcrumb />
      {children}                       ← page content goes here
    </div>
  </main>
</div>
```

### Breakpoints

| Breakpoint | Change                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| `< 768px`  | Sidebar hidden, fixed menu button shown, content padded to start below it |
| `≥ 768px`  | Sidebar fixed visible, main gets `margin-left: 320px`, more padding       |
| `≥ 1180px` | Two-column page grid (article + TOC), max-width expands to 1240px         |

---

## Page Components

All in `src/components/docs-shell/page.tsx`. Use these for every docs page.

```tsx
import { DocsPage, DocsTitle, DocsDescription, DocsBody } from "@/components/docs-shell/page";

<DocsPage toc={toc}>
  <DocsTitle>Page Title</DocsTitle>
  <DocsDescription>Optional subtitle.</DocsDescription>
  <DocsBody>{/* MDX content or custom content */}</DocsBody>
</DocsPage>;
```

- `<DocsPage full>` — spans full width (no TOC column), use for wide content like API reference tables
- `<DocsPage toc={toc}>` — renders sticky TOC sidebar at 1180px+ (right column, 230px wide)
- Article max-width is 760px (760px + gap + 230px TOC = ~1060px inside 1240px container)

### Page actions and the Markdown agents get

`[[...slug]]/page.tsx` puts the title in `.launch-docs-header` beside `PageActions` (`page-actions.tsx`): **Copy page**, with View as Markdown and Open in ChatGPT or Claude behind its chevron. Copy page fetches the page's `.md` and copies that response, so it always matches what agents get; below 640px it drops its label. The `.md` route (`src/app/api/docs-md`) opens every page, the home included, with a one-line context block linking the docs index (`/docs.md`, every page), `llms.txt` (the key pages) and `SKILL.md`, then the page's title and description.

Popovers (`fumadocs-ui/components/ui/popover`) render in a portal outside `.sdp-docs-shell`: give their content `.launch-popover`, which sets the type, surface, `--elevation-popover` and the motion-token animation.

### CSS classes (for custom elements within pages)

| Class                       | Element                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.launch-docs-title`        | H1, clamp(30px, 3.4vw, 36px), weight 500, letter-spacing -0.02em: the article display size, above the tokens' 24px page title                            |
| `.launch-docs-description`  | Subtitle `<p>`, `--font-size-subheading`, `--ink-secondary`, max-width 720px                                                                             |
| `.launch-docs-body`         | Content wrapper, `--ink-secondary`                                                                                                                       |
| `.launch-mdx-heading`       | Base heading style (weight 500, `--ink`, `--letter-spacing-heading`)                                                                                     |
| `.launch-mdx-heading-2`     | H2: `--font-size-heading` (24/32), margin-top 52px                                                                                                       |
| `.launch-mdx-heading-3`     | H3: `--font-size-subheading` (18/24), margin-top 34px                                                                                                    |
| `.launch-mdx-heading-4`     | H4: `--font-size-field` (16/24), margin-top 28px                                                                                                         |
| `.launch-mdx-paragraph`     | Body paragraph, 15px, line-height 1.68, margin-bottom 18px                                                                                               |
| `.launch-mdx-link`          | Links: `--ink`, weight 500, `--ink-tertiary` underline offset 3px                                                                                        |
| `.launch-mdx-list`          | `<ul>` / `<ol>` one-column grid (`minmax(0, 1fr)`, so a code block in an item scrolls instead of widening the page), gap 9px                             |
| `.launch-mdx-table-frame`   | Wraps every MDX table: border, `--corner-card` radius, `--paper-card` bg; a table wider than the column scrolls inside it                                |
| `.launch-mdx-table`         | Full-width table inside the frame                                                                                                                        |
| `.launch-mdx-th`            | Table header: `--paper-tile` bg, 13px, weight 500                                                                                                        |
| `.launch-mdx-td`            | Table cell: 14px                                                                                                                                         |
| `.launch-docs-action-links` | `<ActionLinks>`: a page's action links as raised chips (`--chip` + `--chip-ring`); a `download` link leads with a download icon, a JSON link with braces |

`DocsBreadcrumb` (`breadcrumb.tsx`) links each folder above the page to its landing page: its index, or else its first page, so a section whose meta lists its overview as a child still links. A folder whose index is the page ends the trail (an API family's table shows Reference > API > Payments), and a step that is the page itself, or a folder with no page, is a quieter label.

---

## Sidebar Components

`src/components/docs-shell/sidebar.tsx`: `"use client"`, receives `tree` (Fumadocs page tree), optional `dashboardUrl` and `agentSetup`. The header chips are Platform, Dashboard and the **Agent setup** menu (`agent-setup.tsx`): one tab per coding agent, each a copyable `npx skills add` command. The layout builds the commands with `getAgentSetupOptions()` (`src/lib/agent-setup.ts`). Nothing unreleased is offered on any deployment: the docs skill always installs, and a module skill in `MODULE_SKILLS` shows only while its `listed` toggle is true, its module is stable, and the deployment publishes that module (`isModulePublished`, which applies a hold such as Earn's). The MCP tab's toggle is `DOCS_MCP_COMMAND`: null hides it until the docs MCP ships. The footer holds the network status rows, an `llms.txt` link and the Fumadocs `ThemeSwitch` (light, dark, system).

**Do not add new navigation patterns outside the page tree.** Navigation is auto-generated from `source.pageTree` via Fumadocs. To add pages to the sidebar, add MDX files to `content/docs/` and update `meta.json`.

### Navigation node icons (`navigation-node.tsx`)

Sidebar icons are optional and opt-in per page/folder. Set `icon: <LucideName>` (e.g. `icon: BookOpen`) in a page's MDX frontmatter or a folder's `meta.json`; the loader in `src/lib/source.ts` resolves the name against `lucide-react` exports (unknown names throw at build time) and `NavigationNode` renders it before the label via `.launch-docs-nav-icon`. The one exception is `icon: method:<METHOD>`, which the API reference generator writes on each operation page: it renders the HTTP method in its colour instead of an icon. Pages without an `icon` stay text-only. The folder expand/collapse chevron (one `ChevronRight` that turns to point down while the folder is open, on the motion tokens; the toggle carries `aria-expanded`) is unrelated and always shown.

### Search

⌘K search works out of the box: `RootProvider` (root `layout.tsx`) provides the Fumadocs search dialog + hotkey, backed by the Orama route at `src/app/api/search/route.ts` (`createFromSource(source)`). The sidebar header has a "Search docs" trigger button (`.launch-docs-sidebar-search`). Only `content/docs/` MDX is indexed — JSX-rendered content like `DocsHome` is not.

---

## Sidebar CSS Classes Reference

| Class                             | Purpose                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `.launch-docs-sidebar`            | Fixed 320px sidebar, `--paper-side` bg, border-right                                                                              |
| `.launch-docs-sidebar-header`     | Logo, action chips and search, border-bottom                                                                                      |
| `.launch-docs-brand`              | Logo link (flex, gap 12px)                                                                                                        |
| `.launch-docs-brand-mark`         | 36×36px icon box, `--paper` bg, border-radius 10px                                                                                |
| `.launch-docs-sidebar-actions`    | Two equal columns; an odd last chip (Agent setup beside Platform and Dashboard) takes a full row                                  |
| `.launch-docs-sidebar-action`     | Chip links (`--chip` + `--chip-ring`), `--control-height-sm`, `--font-size-meta`                                                  |
| `.launch-docs-sidebar-search`     | Search trigger, `--control-height-md`, `--wash` fill; the `⌘K` keys are chips                                                     |
| `.launch-docs-sidebar-nav`        | Scrollable nav area                                                                                                               |
| `.launch-docs-nav-item`           | Page link: `--font-size-body`, `--ink-secondary`, `--wash` on hover                                                               |
| `.launch-docs-nav-item.is-active` | Active page: `--wash-strong` bg, `--ink`, weight 500                                                                              |
| `.launch-docs-nav-folder`         | Folder container                                                                                                                  |
| `.launch-docs-nav-folder-row`     | A folder's row and its one highlight, toggle included: `--wash` on hover, `--wash-strong` (`.is-active`) on the folder's own page |
| `.launch-docs-nav-folder-btn`     | Non-linked folder label that toggles the folder: `--ink`, weight 500                                                              |
| `.launch-docs-nav-folder-link`    | Linked folder: `--ink`, weight 500; a click opens the folder, or toggles it from the folder's own page                            |
| `.launch-docs-nav-toggle`         | Expand/collapse chevron button, 28px                                                                                              |
| `.launch-docs-nav-children`       | Children container, 14px further in per level, highlights included                                                                |
| `.launch-docs-sidebar-section`    | Section label: `--font-size-meta`, `--ink-tertiary`, sentence case                                                                |
| `.launch-docs-sidebar-separator`  | Plain 1px `--rule-faint` rule                                                                                                     |
| `.launch-docs-sidebar-status`     | Footer: status rows (`.launch-docs-status-list`, ending in the `llms.txt` link) and the theme switch                              |

---

## Creating a New Page

1. Add an MDX file to `content/docs/<section>/my-page.mdx`
2. Update `content/docs/meta.json` (and section `meta.json`) to include it
3. Create a route in `src/app/docs/<section>/my-page/page.tsx`:

```tsx
import { DocsPage, DocsTitle, DocsDescription, DocsBody } from "@/components/docs-shell/page";
import { getMDXContent } from "@/lib/source"; // or use getPage() from fumadocs

export default function MyPage() {
  return (
    <DocsPage>
      <DocsTitle>My Page</DocsTitle>
      <DocsDescription>Brief subtitle here.</DocsDescription>
      <DocsBody>{/* content */}</DocsBody>
    </DocsPage>
  );
}
```

4. For full-width layout (no TOC): `<DocsPage full>`
5. For TOC: pass `toc` array of `{ title, url, depth }` to `<DocsPage toc={toc}>`

## Unpublishing a Page

Every MDX under `content/docs/` is built and served (static params) and indexed for search whether or not `meta.json` lists it. Removing the nav entry hides the sidebar link and drops the page from the navigation-driven `llms-full.txt`, but the URL keeps serving. To take a page down while keeping it in the repo:
1. `git mv` it under `content/unpublished/` (same relative path). Nothing reads that directory.
2. Remove it from the section `meta.json`.
3. Repoint or drop inbound links from other pages; `check:links` fails on a link to a missing page.
4. Run `pnpm generate:api && pnpm generate:ai` and commit `public/llms*.txt`; CI diffs them against the generated output.

## Release Channels

Each docs deployment documents only what its release channel publishes. The API decides that (`createPublicSurfaceManifest` in `apps/sdp-api/src/openapi/spec.ts`: modules, ramp providers and the actions an API key can be granted, Earn's hold included, plus the rate limits every channel enforces); `generate:api` writes it to `src/generated/public-surface.json` from `SDP_RELEASE_CHANNEL` (required on Vercel; `experimental` when unset elsewhere, which is what the committed file holds).

Before documenting a new ramp provider, follow
`docs/contributing/ramp-provider-safety.md` and verify its sandbox settlement
evidence. Describe provider `settled` as pending chain verification, not final
delivery.

Gates follow module declarations, never sentences:
- A page about one module takes `module: issuance` (or `ramps`, …) frontmatter; a page about one ramp provider takes `rampProvider: moonpay` (ramp provider pages are `payments/ramps-<provider>.mdx`). Outside the channel the page leaves `source` (it 404s and drops out of the sidebar, search, sitemap and the Markdown route) and the `llms*.txt` files.
- Shared pages never name a module. Module-specific content lives on that module's pages; where a shared page lists modules, providers or operations, it places a generated block instead: `<ModuleTable />`, `<ModuleCapabilities />`, `<RampProviderMatrix />`, `<ApiKeyGrantsTable />`, and `<RateLimitTable />` for the API's limits. The blocks render from `src/lib/docs-catalog.ts` (add a module or provider there) and the manifest.
- `remarkDocsBlocks` (`src/lib/docs-blocks.ts`) expands the blocks before Fumadocs extracts headings and search text; `expandDocsBlocks` puts the same Markdown into raw MDX for the llms files, the Markdown route and the link checker. A `rotate-providers` code fence shows only published providers.
- Frontmatter (titles, descriptions) of shared pages must stay module-neutral.
- `check:links` checks the channel in the manifest; CI runs it on `experimental` and `stable`.
- Committed generated files (`public/llms*.txt`, Postman, `content/docs/meta.json`, `reference/api/index.mdx`, `src/generated/public-surface.json`) are built at `experimental`; the deployment's build regenerates them for its channel.
- The docs skill (`public/SKILL.md`, and the same file at the repo's `skills/sdp-docs/SKILL.md`, which `npx skills add` installs from GitHub) is the exception: it names no module, so one copy fits every channel. `generate:ai` links only shared pages from it and fails on a gated or missing one; send readers to `llms.txt` for what a channel publishes.

API reference pages are different: they are generated from the public OpenAPI document, a folder per tag, so a family appears and disappears with that document (`EARN_PUBLIC_SURFACE_PUBLISHED` in `apps/sdp-api/src/openapi/spec.ts` is the one such switch). The docs keep no list of families of their own, and an untagged operation fails `generate:api`.
- `openapi:generate` also writes the channel's reference model (`apps/sdp-api/generated/api-reference.json`, gitignored; the contract is `@sdp/api-catalog/reference`, built by `apps/sdp-api/src/openapi/reference.ts`). A schema keyword the model cannot carry fails the build there.
- `generate-api-docs.mjs` parses it and, with `scripts/lib/api-reference-page.ts`, writes a folder per family (`reference/api/<family>/`): `index.mdx`, the family's table of operations (Method, Endpoint, Summary, each row one link to its operation), and a page per operation named by its `endpointId` (`create-wallet.mdx`), which the folder's `meta.json` lists in document order. An operation page is titled by its summary, described by the description's first sentence, and holds its parameters, request body, responses, a cURL, TypeScript and Python sample (`tab=` fences, from `@sdp/api-catalog/snippets`, sending an `Idempotency-Key` only where the route declares one) and an example per status. The generator fails if a table misses an operation or a page misses a sample.
- A family whose routes name groups (`x-sdp-group`, the model's `group`; two or more) keeps each group's pages in a `(group)` folder with its own `meta.json`: Fumadocs shows it as a collapsible sidebar folder and leaves it out of URLs, so an operation stays at `<family>/<endpointId>`. Its table gets a heading per group. `operationGroups` lays out both; a family with fewer than two groups stays flat. Scripts that read files take slugs from `docsPageSlugOf` (`src/lib/site.ts`), which drops `(group)` folders as Fumadocs does, and the `.md` route reads the page's own file (`page.path`).
- The pages are Markdown, so `.md`, `llms-full.txt` and search carry everything. `expandDocsBlocks` writes `<ApiEndpoint />` as `METHOD /path` in a code span (search gets the same text) and unwraps the wrappers to their content: `<ApiOperationTable>` also points each row at its operation's `.md`, while `<ActionLinks>` (a page's action links as chips, the Postman download), `<ApiOperation>` and `<ApiPanel>` only lay a page out. A new reference component needs both forms. `check:links` accepts a page's `.md`, and `generate-ai-resources.ts` reads a family folder's index as its first page and names a group's section after its family (`Payments: Transfers`).
- On a reference page, `remarkDocsBlocks` sets each `·` between a field's facts in a `.launch-api-separator` span so the dots get room, and points the code at this deployment's API: it swaps `canonicalSite.apiUrl` for `apiUrl` (`src/lib/site.ts`, from `NEXT_PUBLIC_SDP_API_URL`, which the Docker image fills in at start). On Vercel the variable needs setting per environment, like `SDP_RELEASE_CHANNEL`; a deployment without it shows the canonical host. The MDX, the `.md` route and the llms files keep the plain text and the canonical host.
- On an operation page, `apiReference: true` makes the page full width with no table of contents and scopes the `.is-api-reference` styles in `globals.css`, and `icon: method:<METHOD>` puts its method beside it in the sidebar (`src/lib/source.ts`). Each sample is a box whose code scrolls inside it. From 1280px its `<ApiPanel>` (the samples and example responses) sits beside the body; on a window at least 750px tall it stays in view, sized to the window, and never scrolls itself: the last box (the example responses) takes the height left, which 750px keeps at 10 lines or more. Below, it follows the body.

Reference > Conventions (`content/docs/reference/conventions/`) holds the rules every route shares (errors, pagination, rate limits, versioning) and links the authentication, environments and idempotency guides; the API Reference index links it. It is written by hand, apart from `<RateLimitTable />`, names no module, and lives outside `reference/api/`, which `generate:api` rewrites.

Currently unpublished: the whole Earn family, guide and API reference, until PRO-2038.

---

## Do's and Don'ts

- **Do** read colors, type sizes, radii, control heights and motion from `@sdp/design-tokens` (`--paper*`, `--ink*`, `--rule*`, `--wash*`, `--font-size-*`, `--corner-*`, `--control-height-*`, `--motion-*`)
- **Do** use `var(--font-sans)` for text and `var(--font-mono)` for code, at weights 400 and 500 only
- **Do** use `<DocsPage>`, `<DocsTitle>`, `<DocsDescription>`, `<DocsBody>` as the page wrapper
- **Do** use Lucide React for all icons (already a dependency)
- **Don't** hardcode colors — always use design tokens
- **Don't** add new global layout structures — the shell is `sdp-docs-shell` → sidebar + main, keep it
- **Don't** use Fumadocs UI components directly for layout (they're used internally); the custom shell wraps them
- **Don't** change `--color-fd-*` tokens independently: they point at the refresh palette
- **Don't** drop the `*` border rule in the base layer of `globals.css`: Tailwind's preflight resets every border to `currentColor` after Fumadocs' base layer sets it


When working on design or frontend changes:
- Reuse existing templates and typography styles from the codebase rather than creating new ones when something suitable already exists.
- When adding images, download and store a local copy in the project. Never reference external URLs directly.
- Raw `<img>` srcs (JSX/TSX or inline `<img>` in MDX) must point at `/docs/images/...`, not `/images/...`. Production traffic arrives through sdp-web's `/docs/:path*` proxy, which never forwards root-level `/images` requests; a rewrite in `next.config.mjs` maps `/docs/images/*` back onto `public/images/*`. Markdown-syntax images (`![](/images/...)`) are exempt: fumadocs-mdx compiles them to static imports that already resolve correctly.
- sdp-web forwards only `/docs`, `/docs/*`, `/docs.md`, `/llms.txt`, `/llms-full.txt`, `/SKILL.md`, `/postman/collection.json` and `/provider-onboarding/*` to this app (`apps/sdp-web/next.config.ts`). Any other root-level route here 404s on platform.solana.com until it gets a rewrite there.
- Use proper image sizes relative to their container — do not use oversized images (e.g., 1024px for a 32px container). Use at most 2x the container size for retina support.
- Run `npm run build` and check for errors before pushing to staging.
