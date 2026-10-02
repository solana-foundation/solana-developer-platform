# @sdp/design-tokens

Every colour, font, type size, radius and control size SDP UI is built from, as plain CSS
custom properties, with Tailwind utilities mapped onto them. The
dashboard (`apps/sdp-web`) consumes the package today. A future Storybook or docs page can
read the same files without Tailwind.

## Files

| File | What it holds |
| -- | -- |
| `src/tokens.css` | The values. Light values on `:root`, dark values on `:root.dark`. |
| `src/theme.css` | Tailwind v4 `@theme inline` mappings (`bg-surface`, `text-body`, `rounded-control`, `max-w-page`, …) and the `refresh:` variant. |
| `src/index.ts` | The refresh-theme attribute (`refreshThemeProps`) and the scale names for `tailwind-merge` (`tailwindThemeScales`). |
| `src/assets/fonts/` | The refresh design's faces: Season Sans (Regular, Medium) and Geist Mono (variable, Latin subset), as woff2. |

## Layers

1. **Base palette.** The product palette every dashboard screen uses: `--surface*`,
   `--emph-*`, `--t4`/`--t8`/`--t12`, `--border-*`, the status hues, and the base font stacks
   `--font-sans` and `--font-mono`.
2. **Refresh palette.** The 2026 Payments design, light and dark, taken verbatim from the
   design's own stylesheet: the papers (`--paper` for the page, `--paper-side` for the
   sidebar, `--paper-card`, and `--paper-tile` for tiles and grouped lists), an ink scale (`--ink*`), washes and rules as ink at an alpha,
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

`apps/sdp-web/src/app/globals.css` imports them this way, so the dashboard reads the base
palette from the package. Nothing in sdp-web renders a refresh scope yet: every screen stays on the
base palette until a surface opts in.

Opt a surface into the refresh design with the attribute. On `<html>` it adopts the design
app-wide, in light and dark:

```tsx
import { refreshThemeProps } from "@sdp/design-tokens";

<section {...refreshThemeProps}>…</section>
```

Content portaled out of that element (modals, menus, popovers) leaves the scope, so it has to
carry the attribute itself.

When a component needs different styling inside a refresh surface, use the variant rather
than a second component:

```tsx
<div className="rounded-lg bg-fill-subtle refresh:rounded-card refresh:bg-transparent" />
```

In custom CSS and arbitrary values, read the palette names (`var(--amber-tx)`,
`var(--surface-raised)`), not Tailwind's `--color-*` names. `@theme inline` declares
`--color-warning: var(--amber-tx)` on `:root`, where it resolves once, so inside a nested refresh
scope a `var(--color-warning)` keeps the base value. Utilities aren't affected: they inline the
palette name.

### Fonts

The refresh stacks read `--font-season-sans` and `--font-geist-mono`, so the app loads the
files in `src/assets/fonts` and exposes them under those names. In Next.js, load each with
`next/font/local`, set `variable` to that name, and put the font's `variable` class on
`<html>`. Elsewhere, declare `@font-face` rules for the same files and set the two variables
on `:root`. Without either, the stack falls back to the installed family name, then the system
stack. sdp-web doesn't load them yet.

### Page column

`max-w-page` is the design's content column (852px, which with 24px gutters is the design's
900px column). `max-w-flow` is the wizard and settings form column (660px).

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

1. Declare it in `src/tokens.css`. Add a dark value under `:root.dark` when it differs in dark
   mode. If the refresh design changes it, re-point it in the refresh scope block.
2. If it needs a utility, map it in `src/theme.css`. A new scale name (a `text-*` size, a
   `rounded-*` radius, a `shadow-*`, …) also goes in `tailwindThemeScales`.

## Storybook

The package is laid out so a Storybook can document it without new plumbing:

- Swatch and scale stories can read live values with
  `getComputedStyle(element).getPropertyValue(name)`. Light, dark and refresh then come from the
  same stories, by toggling `.dark` and `refreshThemeProps` on the story root. A typed list of
  the tokens to iterate over can come back with the Storybook that reads it.
- Component stories import `tokens.css` and `theme.css` in the Storybook preview, the same
  way `globals.css` does, and declare the two font variables from `src/assets/fonts`, so
  components render exactly as they do in the dashboard.
