# @sdp/design-tokens

Every colour, type size, radius and control size SDP UI is built from, as plain CSS custom
properties. Tailwind utilities map onto them, and a typed catalog describes them. The
dashboard (`apps/sdp-web`) consumes the package today. A future Storybook or docs page can
read the same files without Tailwind.

## Files

| File | What it holds |
| -- | -- |
| `src/tokens.css` | The values. Light values on `:root`, dark values on `:root.dark`. |
| `src/theme.css` | Tailwind v4 `@theme inline` mappings (`bg-surface`, `text-body`, `rounded-control`, `max-w-flow`, …) and the `refresh:` variant. |
| `src/index.ts` | Typed catalog: every token's name, group, description and utility. It also exports the refresh-theme attribute and the scale names for `tailwind-merge`. |
| `src/catalog.test.ts` | Keeps the CSS and the catalog in step. |

## Layers

1. **Base palette.** The product palette every dashboard screen uses: `--surface*`,
   `--emph-*`, `--t4`/`--t8`/`--t12`, `--border-*` and the status hues.
2. **Refresh palette.** The 2026 Payments design, with darker inks, lighter rules and muted
   status hues (`--ink*`, `--wash*`, `--rule*`, `--positive`, …). It sits next to the base
   palette so the two can be documented side by side.
3. **Refresh scope.** `[data-sdp-theme="refresh"]` points the base names at the refresh values.
   Everything inside that element renders in the new design, shared components included,
   with no per-component overrides.

The type, radius, control-height, layout, elevation and motion tokens are the same in both
themes.

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

In the dashboard, `ThemeScopeProvider` (`apps/sdp-web/src/components/theme-scope.tsx`) sets
the attribute from the route (`src/lib/theme-scope-routes.ts`). Today that covers Payments
and Privacy. Portaled content (modals, menus, popovers) re-stamps it through
`useThemeScopeAttributes`, because a portal leaves the scoped subtree.

When a component needs different styling inside a refresh surface, use the variant rather
than a second component:

```tsx
<div className="rounded-lg bg-fill-subtle refresh:rounded-card refresh:bg-transparent" />
```

Where the structure differs as well, read `useThemeScope() === "refresh"` in a client
component.

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
  way `globals.css` does, so components render exactly as they do in the dashboard.
