---
name: rail-discovery
description: Declare which fiat↔crypto rails a ramp provider supports. Implement _discoverRails + readRailSupport and add a RAMP_RAIL_DUMPS entry, then regenerate the committed support matrix. Use when opening a PR against apps/sdp-api to add or update a ramp provider's supported currencies/corridors.
---

# Rail discovery

The platform serves a generated support matrix — which `(fiat, crypto)` pairs each provider can on/off-ramp — from `packages/sdp-types/src/generated/ramp-support.generated.ts` (`ONRAMP_SUPPORT`, `OFFRAMP_SUPPORT`, `RAMP_FIAT_CURRENCIES`). You do **not** hand-edit that file. You teach your provider to report its rails, then a script turns live provider responses into the matrix.

You implement three things; the codegen (`apps/sdp-api/scripts/discover-ramp-rails.ts`) does the rest:

1. a `RAMP_RAIL_DUMPS.<id>` entry in `lib/ramps/shared.ts`
2. `_discoverRails` — HTTP → raw response dumps
3. `readRailSupport` — dumps → a `ProviderRampSupport`

**Canonical example: `lib/ramps/providers/lightspark/client.ts`** (one dump, simplest). For a multi-endpoint provider, copy `bvnk/client.ts` (three dumps).

## The data flow

```
_discoverRails ──fetch──▶ .ramp-rails/<id>/*.json   (gitignored raw dumps)
readRailSupport ──parse──▶ ProviderRampSupport       (4 sets of rails)
codegen ──merge all providers──▶ ramp-support.generated.ts  (committed)
```

`.ramp-rails/` is gitignored — dumps are local scratch. The generated `.ts` is committed and must be regenerated when your support changes.

## Step 1 — declare your dumps

Add an entry to `RAMP_RAIL_DUMPS` in `lib/ramps/shared.ts`, one per upstream response you need:

```ts
<id>: {
  currencies: { name: "<id>/currencies", file: dumpFile("<id>/currencies") },
},
```

`name` is what `_discoverRails` writes; `file` is what `readRailSupport` reads back.

## Step 2 — `_discoverRails`

HTTP only. Read **sandbox** creds from the passed `env` with `requireEnv` (it throws on a missing key — don't add a presence check), fetch each upstream endpoint with the injected `fetchJson`, and `writeDump` the raw response. No parsing, no mapping here — just capture.

```ts
async _discoverRails({ env, fetchJson, writeDump }: Parameters<RampProvider["_discoverRails"]>[0]) {
  const apiKey = requireEnv(env, "<PROVIDER>_SANDBOX_API_KEY");
  await writeDump(
    RAMP_RAIL_DUMPS.<id>.currencies.name,
    await fetchJson(this.id, "GET /currencies", `https://.../currencies?apiKey=${apiKey}`)
  );
}
```

Use the provider's most public/anonymous discovery endpoints where possible (see BVNK's anon `/api/currency/*?offset=0&max=1000` paging). `_discoverRails` is `@internal` — only the discovery script ever calls it.

## Step 3 — `readRailSupport`

Pure: read the dump(s) with `readDump<T>(RAMP_RAIL_DUMPS.<id>.<key>.file)` and map into a `ProviderRampSupport`. Keep the mapping in a standalone `extractSupport()` so it's unit-testable without HTTP.

`ProviderRampSupport` is four sets — start from `createProviderRampSupport()` and fill them:

```ts
{ onrampFiats: Set<FiatCurrencyCode>, onrampCryptos: Set<CryptoRailId>,
  offrampFiats: Set<FiatCurrencyCode>, offrampCryptos: Set<CryptoRailId> }
```

Mapping rules (both helpers live in `shared.ts` / `@sdp/types/payment-rails`):

- **Crypto code → `CryptoRailId`** — Solana assets only today: `isSolanaCryptoAsset(code)` then `SOLANA_ASSET_TO_RAIL[code]` (e.g. `USDC` → `usdc.solana`). Skip anything else.
- **Fiat code → `FiatCurrencyCode`** — `parseFiatCurrency(code.toUpperCase())`; skip when it returns null. Uppercase ISO only.
- Add a rail to `onramp*` vs `offramp*` based on what the upstream reports as enabled (Lightspark keys off `enabledTransactionTypes` `INCOMING`/`OUTGOING`; MoonPay off currency `type`; BVNK off which of the crypto/fiat/deposit lists it appears in).

## Generate + verify

Discovery hits live sandbox APIs, so it runs under Doppler:

```bash
# from apps/sdp-api — full refresh (all providers) + regenerate the committed matrix
pnpm --filter @sdp/api rails:discover --emit
# just your provider
pnpm --filter @sdp/api rails:discover <id> --emit
# fail loudly if any discovery call errors
pnpm --filter @sdp/api rails:discover --emit --strict

# regenerate from existing dumps only (no network, no creds)
pnpm --filter @sdp/api rails:generate

# confirm the committed matrix isn't stale
pnpm --filter @sdp/api rails:drift
```

Commit the regenerated `ramp-support.generated.ts` (and confirm your provider's row in `RAMP_PROVIDER_SUPPORT_COUNTS` looks sane). Do **not** commit `.ramp-rails/`.

## Rules

- HTTP only in `_discoverRails` — no DB, no business logic.
- `readRailSupport` is pure over the dumps — no fetching.
- No fallbacks: a missing cred throws via `requireEnv`; a malformed dump should throw, not silently yield empty support.
- Strong typing: status/type maps are `as const satisfies Record<…>`; no `any`.
- Your provider must already be registered (`register-provider`) — the codegen iterates `RAMP_PROVIDERS` and will fail if a client is missing.
