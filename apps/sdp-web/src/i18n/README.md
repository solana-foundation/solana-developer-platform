# Dashboard translations

The dashboard keeps its supported BCP-47 locales in `config.ts` and its English source catalog in `../../messages/en.json`.

Supported locales today: `en`, `fr`. French catalogs live under `../../messages/fr/`. The release workflow restores 100% key parity with English before release; at runtime, a temporarily missing localized key falls back to its English source value.

Product PRs add or change copy only in the English source catalogs. Do not update French in the same PR: the release workflow asks Eve to fill missing locale keys on the repository-owned `codex/release-main` branch. The catalog policy verifies both that branch name and its source repository before allowing mixed catalog changes. A dedicated translation-quality PR may change localized catalogs as long as it does not also introduce English source changes.

Eve receives the locale rules in `.github/translation-guidance.json` plus the namespace and nearby approved translations for every new string. That guidance is the terminology source of truth. In French, established product terms such as `Token` and `Wallet` stay in English; literal `jeton` and `portefeuille` variants are rejected by catalog validation.

Use `await getTranslations()` in Server Components and `useTranslations()` in Client Components. Both accept only keys that exist in the English catalog. For dates, numbers, lists, and relative time, construct the native `Intl` formatter with the resolved locale rather than pinning it to `en-US`.

To add a locale, add its BCP-47 tag to `supportedLocales`, add a same-shaped catalog, and register it in `messagesByLocale`. The request resolver gives a valid locale cookie priority, then uses `Accept-Language`, falling back to English. A future language picker should persist its selection in the `sdp-locale` cookie.

`pnpm --filter sdp-web check:i18n` detects new JSX text, accessible labels, placeholders, and common label/title/description properties. Existing copy is intentionally tracked in `ui-copy-baseline.json` during this groundwork phase; migrate an entry to the catalog and refresh that baseline in the same PR. Never add new user-facing copy to the baseline.

`pnpm --filter sdp-web check:i18n:strict` is the completion gate. It permits only catalog-backed copy or line-specific, reasoned entries in `ui-copy-exemptions.json` for protocol data or proper nouns that cannot be translated.
