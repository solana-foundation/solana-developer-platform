# Dashboard translations

The dashboard keeps its supported BCP-47 locales in `config.ts` and its English source catalog in `../../messages/en.json`.

Supported locales today: `en`, `fr`. French catalogs live under `../../messages/fr/` and must keep a 100% matching key inventory with English.

Use `await getTranslations()` in Server Components and `useTranslations()` in Client Components. Both accept only keys that exist in the English catalog. For dates, numbers, lists, and relative time, construct the native `Intl` formatter with the resolved locale rather than pinning it to `en-US`.

To add a locale, add its BCP-47 tag to `supportedLocales`, add a same-shaped catalog, and register it in `messagesByLocale`. The request resolver gives a valid locale cookie priority, then uses `Accept-Language`, falling back to English. A future language picker should persist its selection in the `sdp-locale` cookie.

`pnpm --filter sdp-web check:i18n` detects new JSX text, accessible labels, placeholders, and common label/title/description properties. Existing copy is intentionally tracked in `ui-copy-baseline.json` during this groundwork phase; migrate an entry to the catalog and refresh that baseline in the same PR. Never add new user-facing copy to the baseline.

`pnpm --filter sdp-web check:i18n:strict` is the completion gate. It permits only catalog-backed copy or line-specific, reasoned entries in `ui-copy-exemptions.json` for protocol data or proper nouns that cannot be translated.
