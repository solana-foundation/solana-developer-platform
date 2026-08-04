# @sdp/earn — agent notes

Provider-integration layer for SDP Earn. Ground is the first live provider;
the design is multi-provider — keep every provider-specific detail behind the
provider-neutral seams below. Read `README.md` here for the full architecture;
ADR 0002 (`docs/decisions/`) for the invariants.

## Contracts

- `EarnVaultProvider` (src/types.ts) is the base contract; the portfolio-wallet
  surface (`EarnPortfolioWalletProvider`) is an **optional capability** detected
  via `supportsPortfolioWallets()` (src/capabilities.ts, all-or-nothing method
  presence). New optional surfaces follow the same pattern: interface extension
  + type guard in capabilities.ts — never `instanceof` or provider-id checks.
- All USD/amount values in contract types are **decimal strings**; convert to
  wire numbers only at the provider HTTP boundary.
- Registry: `EARN_PROVIDER_CLIENTS` (src/index.ts) + fail-closed
  `resolveEarnProviderClient` — DB provider ids are open strings and MUST be
  resolved through this, never direct-indexed.

## Hard invariants (ADR 0002)

- **Money out beats money off**: nothing in this package may make withdrawals
  depend on availability/enablement — only on configured credentials.
- Catalogue mapping must exclude anything that would trap funds (Ground:
  `mode === "buy_only"` sources are skipped, only `active` is listed).
- Missing API key ⇒ throw `PROVIDER_NOT_CONFIGURED` **before** any network call.

## Conventions

- New provider = subclass `providers/stub.ts` (`StubEarnClient`), register in
  `EARN_PROVIDER_CLIENTS`, add the `./providers/<id>/client` package export.
  A registry-consistency test in src/index.test.ts fails if any of these is
  missing for an id in `EARN_PROVIDERS`.
- All HTTP goes through `providerFetch`/`providerFetchJson` (src/fetch.ts) —
  never raw `fetch` in a client.
- Tests: node:test (`pnpm --filter @sdp/earn test`), **no network** — stub
  global fetch per the canonical pattern in src/fetch.test.ts and
  providers/ground/client.test.ts. Every new client method needs mapping +
  error-taxonomy coverage.
- Ground specifics (base URLs, endpoint shapes, apyBps/liquidity/curator
  mapping decisions) are documented in providers/ground/client.ts doc comments
  and README.md — update both when the mapping changes.

## Cross-package coupling

- Wire DTOs shared with API/web live in `packages/sdp-types/src/earn.ts`.
- Curators/categories are open-string registries in `@sdp/types` — adding one
  is a data change; do not introduce closed curator unions anywhere.
- Env credential names follow `<PROVIDER>_API_KEY` / `<PROVIDER>_SANDBOX_API_KEY`;
  a drift test in apps/sdp-api asserts turbo.json + secret-keys.mjs carry them.
