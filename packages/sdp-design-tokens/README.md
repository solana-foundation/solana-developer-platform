# @sdp/design-tokens

Every colour, font, type size, radius and control size SDP UI is built from, as plain CSS
custom properties, with Tailwind utilities mapped onto them. The
dashboard (`apps/sdp-web`) and the docs (`apps/sdp-docs`) consume the package. A future
Storybook can read the same files without Tailwind.

## Files

| File                | What it holds                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/tokens.css`    | The values. Light values on `:root`, dark values on `:root.dark`.                                     |
| `src/theme.css`     | Tailwind v4 `@theme inline` mappings (`bg-surface`, `text-body`, `rounded-control`, `max-w-page`, …). |
| `src/index.ts`      | The scale names for `tailwind-merge` (`tailwindThemeScales`).                                         |
| `src/assets/fonts/` | The design's faces: Season Sans (Regular, Medium) and Geist Mono (variable, Latin subset), as woff2.  |

## Layers

1. **Palette.** The 2026 design, light and dark, taken verbatim from the design's own
   stylesheet: the papers (`--paper` for the page, `--paper-side` for the sidebar,
   `--paper-card`, and `--paper-tile` for tiles and grouped lists), an ink scale (`--ink*`),
   washes and rules as ink at an alpha, the status hues (`--positive`, `--progress`,
   `--attention`, `--critical`) and the segmented chip.
2. **Utility names.** The names `theme.css` and `@solana/design-system` read: `--surface*`,
   `--emph-*`, `--t4`/`--t8`/`--t12`, `--border-*`, the status names (`--green-*`, `--amber-*`,
   `--red-*`, `--blue-*`, `--crimson-*`), pointed at the palette, and the faces `--font-sans` and
   `--font-mono`.

The type, radius, control-height, layout, elevation and motion tokens are the same in light and
dark. Dark mode is the `.dark` class on `<html>`.

## Using it

In a Tailwind v4 stylesheet, import the tokens before anything that reads them:

```css
@import "tailwindcss";
@import "@sdp/design-tokens/tokens.css";
@import "@sdp/design-tokens/theme.css";
```

`apps/sdp-web/src/app/globals.css` imports them this way, and
`apps/sdp-web/src/app/sdp-theme.css` points the design system's component tokens (fields, tabs,
tables, buttons) at them. In custom CSS and arbitrary values, read the palette names
(`var(--amber-tx)`, `var(--surface-raised)`) or the Tailwind `--color-*` names; both resolve on
`:root`.

### Fonts

The font stacks read `--font-season-sans` and `--font-geist-mono`, so the app loads the
files in `src/assets/fonts` and exposes them under those names. In Next.js, load each with
`next/font/local`, set `variable` to that name, and put the font's `variable` class on
`<html>`. Elsewhere, declare `@font-face` rules for the same files and set the two variables
on `:root`. Without either, the stack falls back to the installed family name, then the system
stack. sdp-web loads them with `next/font/local` in `apps/sdp-web/src/app/layout.tsx`, and
sdp-docs the same way in `apps/sdp-docs/src/app/layout.tsx`.

The fonts are third-party and not under this repository's MIT licence. Season Sans is a
proprietary Displaay face licensed to the Solana Foundation for SDP only. Don't copy it or
reuse it elsewhere. See [`LICENSE-SeasonSans.txt`](src/assets/fonts/LICENSE-SeasonSans.txt).
Geist Mono is SIL OFL 1.1. See [`LICENSE-GeistMono.txt`](src/assets/fonts/LICENSE-GeistMono.txt).

### Page column

`max-w-page` is the design's content column (852px, which with 24px gutters is the design's
900px column). `max-w-flow` is the wizard and settings form column (660px).

### Motion

`--motion-duration-fast` (120ms) is hover and press feedback, `--motion-duration-base` (180ms) a small
reveal such as a menu, tab or disclosure, and `--motion-duration-slow` (240ms) a panel or drawer; pair
them with `--motion-ease-out`. All three drop to 0ms under `prefers-reduced-motion`. The docs read
them today. `--motion-duration-default` (250ms) is the duration Tailwind's `transition` utilities use
(`theme.css`) and is unchanged.

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
   mode.
2. If it needs a utility, map it in `src/theme.css`. A new scale name (a `text-*` size, a
   `rounded-*` radius, a `shadow-*`, …) also goes in `tailwindThemeScales`.

## Storybook

The package is laid out so a Storybook can document it without new plumbing:
- Swatch and scale stories can read live values with
  `getComputedStyle(element).getPropertyValue(name)`. Light and dark then come from the same
  stories, by toggling `.dark` on the story root. A typed list of the tokens to iterate over can
  come back with the Storybook that reads it.
- Component stories import `tokens.css` and `theme.css` in the Storybook preview, the same
  way `globals.css` does, and declare the two font variables from `src/assets/fonts`, so
  components render exactly as they do in the dashboard.
