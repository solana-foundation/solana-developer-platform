# @sdp/design-tokens

Every colour, font, type size, radius and control size SDP UI is built from, as plain CSS
custom properties. Tailwind utilities map onto them, and a typed catalog describes them. The
dashboard (`apps/sdp-web`) consumes the package today. A future Storybook or docs page can
read the same files without Tailwind.

## Files

| File | What it holds |
| -- | -- |
| `src/tokens.css` | The values. Light values on `:root`, dark values on `:root.dark`. |
| `src/theme.css` | Tailwind v4 `@theme inline` mappings (`bg-surface`, `text-body`, `rounded-control`, `max-w-page`, …) and the `refresh:` variant. |
| `src/index.ts` | Typed catalog: every token's name, group, description and utility. It also exports the refresh-theme attribute and the scale names for `tailwind-merge`. |
| `src/catalog.test.ts` | Keeps the CSS and the catalog in step. |
| `src/assets/fonts/` | The app's faces: Season Sans (Regular, Medium) and Geist Mono (variable, Latin subset), as woff2. |

## Layers

1. **Palette.** The 2026 design, light and dark, taken verbatim from the design's own
   stylesheet: the three papers (`--paper` for the page, `--paper-side` for the sidebar,
   `--paper-card`), an ink scale (`--ink*`), washes and rules as ink at an alpha, the status
   hues (`--positive`, `--progress`, `--attention`, `--critical`), the segmented chip, and the
   brand faces (`--font-brand-sans`, `--font-brand-mono`).
2. **Product names.** What utilities, components and `@solana/design-system` read:
   `--surface*`, `--emph-*`, `--t4`/`--t8`/`--t12`, `--border-*`, the status triples and
   `--font-sans`/`--font-mono`. Each points at a palette token on `:root`, so every screen
   renders in the palette and follows it into dark mode. The destructive hue (`--crimson*`)
   is SDP's own and keeps literal values.
3. **Scale.** Type, page title, radius, control-height, layout, elevation and motion tokens,
   the same in both modes.

Dark mode is the `.dark` class on `<html>`.

## Using it

In a Tailwind v4 stylesheet, import the tokens before anything that reads them:

```css
@import "tailwindcss";
@import "@sdp/design-tokens/tokens.css";
@import "@sdp/design-tokens/theme.css";
```

The palette and faces apply everywhere. The refresh design's component treatments (underline
fields, flat tables, tabs on the text, control radii, the sidebar's rows) are opt-in per
surface, with the attribute:

```tsx
import { refreshThemeProps } from "@sdp/design-tokens";

<section {...refreshThemeProps}>…</section>
```

In the dashboard the sidebar carries the attribute on every route, and the shell sets it on
`<main>` from the route (`src/lib/theme-scope-routes.ts`), so on the Overview, a Payments route
or the Privacy connect form the page renders in the design too; other pages keep the base
components on the same palette. The scope's design-system tokens live in
`apps/sdp-web/src/app/sdp-theme.css`. `ThemeScopeProvider`
(`apps/sdp-web/src/components/theme-scope.tsx`) carries the scope to portaled content
(modals, menus, popovers), which re-stamps it through `useThemeScopeAttributes` because a
portal leaves the scoped subtree.

When a component needs different styling inside a refresh surface, use the variant rather
than a second component:

```tsx
<div className="rounded-lg bg-fill-subtle refresh:rounded-card refresh:bg-transparent" />
```

Where the structure differs as well, read `useThemeScope() === "refresh"` in a client
component.

### Fonts

`tokens.css` expects the app to load the files in `src/assets/fonts` and expose them as
`--font-season-sans` and `--font-geist-mono`. The dashboard does that with `next/font/local` in
`apps/sdp-web/src/app/layout.tsx`, which also gives them a system fallback with matching
metrics. A Storybook or a static page can declare the same two variables from `@font-face`
rules pointing at the same files. Without either, the stack falls back to the installed family
name, then the system stack.

Season Sans ships Regular and Medium only. The dashboard sets `font-synthesis-weight: none` on
`:root`, so a semibold or bold request renders the Medium face rather than a synthetic bold.

### Page column

`max-w-page` is the design's content column (852px, which with the shell's 24px gutters is the
design's 900px column). `max-w-flow` is the wizard and settings form column (660px). The shell
lays the title, tabs and content in one column with one gutter, so they share a left edge at
every width.

### Class merging

`text-body` is a size and `text-secondary` is a colour, but plain `tailwind-merge` can't
tell the two apart and drops one of them. Register the scale names from
`tailwindThemeScales`, as `apps/sdp-web/src/lib/utils.ts` does:

```ts
import { tailwindThemeScales } from "@sdp/design-tokens";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: { theme: { ...tailwindThemeScales } },
});
```

## Adding or changing a token

1. Declare it in `src/tokens.css`. A palette colour gets a dark value under `:root.dark` (see
   `THEMED_GROUPS`); a product name points at a palette token instead. Colour and type never go
   in the refresh scope: every page shares them.
2. Add it to `designTokens` in `src/index.ts`, with a group and a one-line description.
3. If it needs a utility, map it in `src/theme.css`. A new scale name also goes in
   `tailwindThemeScales`.
4. Run `pnpm --filter @sdp/design-tokens test`. The catalog test fails if a token is missing
   from either side, if a themed token has no dark value, if a product name doesn't point at
   the palette, or if a utility points at a token that doesn't exist.

## Storybook

The package is laid out so a Storybook can document it without new plumbing:

- Swatch and scale stories can iterate over `designTokens` grouped by `group`, and read live
  values with `getComputedStyle(element).getPropertyValue(token.name)`. Light and dark come
  from the same stories by toggling `.dark` on the story root; component stories toggle
  `refreshThemeProps` for the refresh treatments.
- Component stories import `tokens.css` and `theme.css` in the Storybook preview, the same
  way `globals.css` does, and declare the two font variables from `src/assets/fonts`, so
  components render exactly as they do in the dashboard.
