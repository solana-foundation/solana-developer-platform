# sdp-docs — Design System & Page Guidelines

## Stack

- **Next.js 16** (App Router) + **Fumadocs** (`fumadocs-core`, `fumadocs-ui`) for the docs framework
- **Tailwind v4** via `src/styles/solana-design-system.css`
- **Custom CSS** in `src/app/globals.css` — all layout classes are prefixed `launch-docs-*`
- **Lucide React** for icons

---

## Fonts

Three fonts loaded as CSS variables in `src/app/layout.tsx`:

| Variable | Font | Usage |
|---|---|---|
| `--font-sans` / `--font-inter` | Inter Variable | Body text, nav items |
| `--font-abc-diatype` | ABC Diatype | Headings (`h1`–`h6`), page title, description |
| `--font-berkeley-mono` | Berkeley Mono | Monospace labels, breadcrumbs, sidebar actions, section labels |

Apply via Tailwind utilities: `font-sans`, `font-abc-diatype`, `font-berkeley-mono`.

---

## Color Tokens

All tokens are CSS custom properties defined in `src/app/globals.css`. Always use these — never hardcode colors.

### Semantic tokens (light + dark mode aware)

| Token | Light | Dark | Use for |
|---|---|---|---|
| `--launch-cream` | warm off-white | near-black | page background |
| `--launch-bg` | slightly warm white | dark grey | sidebar, table headers |
| `--launch-white` | pure white | dark card | sidebar, card surfaces |
| `--launch-ink` | very dark warm | near-white | primary text, headings, strong |
| `--launch-text` | medium warm grey | light grey | body text |
| `--launch-muted` | muted warm grey | muted grey | secondary text, nav items, breadcrumbs |
| `--launch-border` | light sand | 10% white | default borders |
| `--launch-border-strong` | darker sand | 18% white | hover borders, blockquote border |
| `--launch-hover-bg` | 48% white | 8% white | hover states |
| `--launch-active-bg` | sand-200 68% | 10% white | active/selected backgrounds |
| `--launch-icon-muted` | sand-500 | muted grey | icon opacity, link underline color |
| `--launch-marker` | warm sand | grey | list item markers |
| `--launch-inline-code-bg/text/border` | sand bg + ink text | dark bg | inline code |

### Fumadocs bridge tokens

Fumadocs components read `--color-fd-*` vars. These are mapped to `--launch-*` values in `:root` — do not change them independently.

---

## Layout Structure

```
<div class="sdp-docs-shell">           ← min-height 100vh, cream bg
  <DocsSidebar />                      ← 320px fixed left, white bg
  <main class="launch-docs-main">      ← margin-left: 320px on desktop
    <div class="launch-docs-main-inner"> ← max-width 1120px (1240px at 1180px+), centered, padded
      <DocsBreadcrumb />
      {children}                       ← page content goes here
    </div>
  </main>
</div>
```

### Breakpoints

| Breakpoint | Change |
|---|---|
| `< 768px` | Sidebar hidden, mobile toggle shown |
| `≥ 768px` | Sidebar fixed visible, main gets `margin-left: 320px`, more padding |
| `≥ 1180px` | Two-column page grid (article + TOC), max-width expands to 1240px |

---

## Page Components

All in `src/components/docs-shell/page.tsx`. Use these for every docs page.

```tsx
import { DocsPage, DocsTitle, DocsDescription, DocsBody } from "@/components/docs-shell/page";

<DocsPage toc={toc}>           // toc?: TocItem[] — omit if no TOC needed
  <DocsTitle>Page Title</DocsTitle>
  <DocsDescription>Optional subtitle.</DocsDescription>
  <DocsBody>
    {/* MDX content or custom content */}
  </DocsBody>
</DocsPage>
```

- `<DocsPage full>` — spans full width (no TOC column), use for wide content like API reference tables
- `<DocsPage toc={toc}>` — renders sticky TOC sidebar at 1180px+ (right column, 230px wide)
- Article max-width is 760px (760px + gap + 230px TOC = ~1060px inside 1240px container)

### CSS classes (for custom elements within pages)

| Class | Element |
|---|---|
| `.launch-docs-title` | H1, ABC Diatype, clamp(36px, 6vw, 56px), weight 700 |
| `.launch-docs-description` | Subtitle `<p>`, ABC Diatype 18px, max-width 720px, margin-bottom 36px |
| `.launch-docs-body` | Content wrapper, Inter, `--launch-text` color |
| `.launch-mdx-heading` | Base heading style (ABC Diatype, bold, ink color) |
| `.launch-mdx-heading-2` | H2 — 26px, margin-top 52px |
| `.launch-mdx-heading-3` | H3 — 20px, margin-top 34px |
| `.launch-mdx-heading-4` | H4 — 16px, margin-top 28px |
| `.launch-mdx-paragraph` | Body paragraph, 15px, line-height 1.68, margin-bottom 18px |
| `.launch-mdx-link` | Links — ink color, weight 650, underline offset 3px |
| `.launch-mdx-list` | `<ul>` / `<ol>` grid, gap 9px |
| `.launch-mdx-table` | Full-width table, border-radius 10px, white bg |
| `.launch-mdx-th` | Table header — sand bg, 13px, weight 650 |
| `.launch-mdx-td` | Table cell — 14px |

---

## Sidebar Components

`src/components/docs-shell/sidebar.tsx` — `"use client"`, receives `tree` (Fumadocs page tree) and optional `dashboardUrl`.

**Do not add new navigation patterns outside the page tree.** Navigation is auto-generated from `source.pageTree` via Fumadocs. To add pages to the sidebar, add MDX files to `content/docs/` and update `meta.json`.

### Navigation node icons (`navigation-node.tsx`)

The current sidebar does not render per-page icons. Page and folder links are text-only; only the folder expand/collapse chevron uses an icon (`ChevronDown` / `ChevronRight` from Lucide). If you want to reintroduce keyword-based icon mapping, add it to `NavigationNode` in `src/components/docs-shell/navigation-node.tsx`.

---

## Sidebar CSS Classes Reference

| Class | Purpose |
|---|---|
| `.launch-docs-sidebar` | Fixed 320px sidebar, white bg, border-right |
| `.launch-docs-sidebar-header` | Logo + action buttons area, border-bottom |
| `.launch-docs-brand` | Logo link (flex, gap 12px) |
| `.launch-docs-brand-mark` | 36×36px icon box, cream bg, border-radius 10px |
| `.launch-docs-sidebar-actions` | 2-col grid of action buttons |
| `.launch-docs-sidebar-action` | Button links — Berkeley Mono 12px, border, radius 8px |
| `.launch-docs-sidebar-nav` | Scrollable nav area |
| `.launch-docs-nav-item` | Page link — Inter 13px, weight 550, muted color, hover bg |
| `.launch-docs-nav-item.is-active` | Active page — sand bg, ink color |
| `.launch-docs-nav-folder` | Folder container |
| `.launch-docs-nav-folder-label` | Non-linked folder label — Berkeley Mono 12px |
| `.launch-docs-nav-folder-link` | Linked folder — same style as nav-item |
| `.launch-docs-nav-toggle` | Expand/collapse chevron button — 24×24px |
| `.launch-docs-nav-children` | Indented children container |
| `.launch-docs-sidebar-section` | Section separator with label — Berkeley Mono 10px uppercase |
| `.launch-docs-sidebar-separator` | Plain 1px horizontal rule |

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
      <DocsBody>
        {/* content */}
      </DocsBody>
    </DocsPage>
  );
}
```

4. For full-width layout (no TOC): `<DocsPage full>`
5. For TOC: pass `toc` array of `{ title, url, depth }` to `<DocsPage toc={toc}>`

---

## Do's and Don'ts

- **Do** use `--launch-*` CSS tokens for all colors
- **Do** use `font-abc-diatype` for headings, `font-sans` for body, `font-berkeley-mono` for labels/mono
- **Do** use `<DocsPage>`, `<DocsTitle>`, `<DocsDescription>`, `<DocsBody>` as the page wrapper
- **Do** use Lucide React for all icons (already a dependency)
- **Don't** hardcode colors — always use design tokens
- **Don't** add new global layout structures — the shell is `sdp-docs-shell` → sidebar + main, keep it
- **Don't** use Fumadocs UI components directly for layout (they're used internally); the custom shell wraps them
- **Don't** change `--color-fd-*` tokens independently — they mirror `--launch-*` tokens


When working on design or frontend changes:

- Reuse existing templates and typography styles from the codebase rather than creating new ones when something suitable already exists.
- When adding images, download and store a local copy in the project. Never reference external URLs directly.
- Use proper image sizes relative to their container — do not use oversized images (e.g., 1024px for a 32px container). Use at most 2x the container size for retina support.
- Run `npm run build` and check for errors before pushing to staging.
