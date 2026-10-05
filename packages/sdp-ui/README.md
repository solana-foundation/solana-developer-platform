# @sdp/ui

The dashboard's UI primitives: buttons, inputs, selects, the combobox, modals and drawers,
tables, tooltips, badges, the date and time fields, list toolbars, skeletons and the rest. They
wrap `@solana/design-system` where it has a component and are styled with Tailwind v4 utilities
over `@sdp/design-tokens`. They live apart from `apps/sdp-web` so a Storybook can render them
without the app.

The package ships TypeScript source, like the other `@sdp/*` packages. Each file is its own
subpath export: `@sdp/ui/button`, `@sdp/ui/modal`, `@sdp/ui/date-picker`, and so on.

## What the host provides

The primitives import nothing from an app. What they need from one comes in through a provider
or a prop:

| Need | How it arrives |
| -- | -- |
| Built-in labels (close, pagination, picker footers, combobox states) | `UiI18nProvider` from `@sdp/ui/i18n`, with a `locale` and a `translate(key, values)`. The keys (`UiMessageKey`) are sdp-web's `Shared.SharedComponents.*` catalog keys, so the package carries no copy. Without a provider a label renders as its key and dates format in English. |
| Theme scope for portaled content | `ThemeScopeProvider` from `@sdp/ui/theme-scope-provider`; popovers, menus and modals read it through `useThemeScopeAttributes` (`@sdp/ui/theme-scope`). |
| Router links | `ActionTile` takes a `linkComponent` (an anchor by default). |
| Class merging | `cn` from `@sdp/ui/cn`, tailwind-merge extended with the token scales. |

## How sdp-web wires it

- `I18nProvider` (`apps/sdp-web/src/i18n/provider.tsx`) renders `UiI18nProvider` with the app's
  catalog, so every tree that has the app's translations, tests included, has the primitives'.
- `ThemeScopeProvider` is the same one the dashboard shell already renders.
- `apps/sdp-web/src/components/ui/<name>.tsx` re-exports `@sdp/ui/<name>`, so the app's
  importers keep their `@/components/ui/...` paths. The `action-tile` shim passes `next/link`.
  `components/theme-scope.ts`, `components/theme-scope-provider.tsx` and `lib/utils.ts`
  (`cn`) re-export the package the same way.
- `apps/sdp-web/src/app/globals.css` adds `@source` for `packages/sdp-ui/src`, so Tailwind
  generates the classes the primitives use.

`code-block` and `paginated-footer` stay in sdp-web: the first renders through the app's Shiki
module, which the API playground shares; the second reads and writes the dashboard's URL state.

## Scripts

```sh
pnpm --filter @sdp/ui typecheck
pnpm --filter @sdp/ui test   # vitest; suites that need a DOM opt into jsdom per file
pnpm --filter @sdp/ui lint
```

Suites that render labels wrap the component in `EnglishUiI18nProvider`
(`src/testing/english-ui-i18n.tsx`), which holds sdp-web's English values for those keys.
