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
| `src/assets/fonts/` | The refresh design's faces: Season Sans (Regular, Medium) and Geist Mono (variable, Latin subset), as woff2. |

## Layers

1. **Base palette.** The product palette every dashboard screen uses: `--surface*`,
   `--emph-*`, `--t4`/`--t8`/`--t12`, `--border-*`, the status hues, and the base font stacks
   `--font-sans` and `--font-mono`.
2. **Refresh palette.** The 2026 Payments design, light and dark, taken verbatim from the
   design's own stylesheet: the three papers (`--paper` for the page, `--paper-side` for the
   sidebar, `--paper-card`), an ink scale (`--ink*`), washes and rules as ink at an alpha,
   the status hues (`--positive`, `--progress`, `--attention`, `--critical`), the segmented
   chip, and the brand faces (`--font-brand-sans`, `--font-brand-mono`). It sits next to the
   base palette so the two can be documented side by side.
3. **Refresh scope.** `[data-sdp-theme="refresh"]` points the base names at the refresh values
   and sets the face. Everything inside that element renders in the new design, shared
   components included, with no per-component overrides.

The type, radius, control-height, layout, elevation and motion tokens are the same in both
themes. Dark mode is the `.dark` class on `<html>`, for both palettes.

## Using it

In a Tailwind v4 stylesheet, import the tokens before anything that reads them:

```css
@import "tailwindcss";
@import "@sdp/design-tokens/tokens.css";
@import "@sdp/design-tokens/theme.css";
```

Opt a surface into the refresh design with the attribute:

```tsx
import { refreshThemeProps } from "@sdp/design-tokens";

<section {...refreshThemeProps}>…</section>
```

In the dashboard the shell sets the attribute on `<main>` from the route
(`src/lib/theme-scope-routes.ts`), so on a Payments or Privacy route the whole screen, sidebar
included, renders in the design; other routes keep the base shell. `ThemeScopeProvider`
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
rules pointing at the same files. Without either, the refresh stack falls back to the installed
family name, then the system stack.

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

1. Declare it in `src/tokens.css`. Add a dark value under `:root.dark` when its group is
   themed (see `THEMED_GROUPS`). If the refresh design changes it, re-point it in the refresh
   scope block.
2. Add it to `designTokens` in `src/index.ts`, with a group and a one-line description.
3. If it needs a utility, map it in `src/theme.css`. A new scale name also goes in
   `tailwindThemeScales`.
4. Run `pnpm --filter @sdp/design-tokens test`. The catalog test fails if a token is missing
   from either side, if a themed token has no dark value, or if a utility points at a token
   that doesn't exist.

## Storybook

The package is laid out so a Storybook can document it without new plumbing:

- Swatch and scale stories can iterate over `designTokens` grouped by `group`, and read live
  values with `getComputedStyle(element).getPropertyValue(token.name)`. Light, dark and
  refresh then come from the same stories, by toggling `.dark` and `refreshThemeProps` on the
  story root.
- Component stories import `tokens.css` and `theme.css` in the Storybook preview, the same
  way `globals.css` does, and declare the two font variables from `src/assets/fonts`, so
  components render exactly as they do in the dashboard.
