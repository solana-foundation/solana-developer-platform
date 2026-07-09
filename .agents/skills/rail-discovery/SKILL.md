---
name: rail-discovery
description: Declare which fiat↔crypto rails a ramp provider supports. Implement _discoverRails + distillRailSupport, declare a <PROVIDER>_DECLARED_RAIL_SUPPORT const, and add a RAMP_RAIL_DUMPS entry, then regenerate the committed support snapshot + matrix. Use when opening a PR against apps/sdp-api to add or update a ramp provider's supported currencies/corridors.
---

# Rail discovery

The platform serves a generated support matrix — which `(fiat, crypto)` pairs each provider can on/off-ramp — from `packages/sdp-types/src/generated/ramp-support.generated.ts` (`ONRAMP_SUPPORT`, `OFFRAMP_SUPPORT`, `RAMP_FIAT_CURRENCIES`). You do **not** hand-edit that file. You teach your provider to report its rails, then a script distills live provider responses into a committed per-provider snapshot and merges every provider's snapshot into the matrix.

You implement four things; the codegen (`apps/sdp-api/scripts/discover-ramp-rails.ts`) does the rest:

1. a `RAMP_RAIL_DUMPS.<id>` entry in `lib/ramps/shared.ts`
2. `_discoverRails` — HTTP → raw response dumps
3. `distillRailSupport` — dumps → a `ProviderRailSupportSnapshot`, reporting any codes it drops
4. a `<PROVIDER>_DECLARED_RAIL_SUPPORT` const — entity types, plus country support for whichever direction your snapshot doesn't discover it for

**Canonical example: `lib/ramps/providers/lightspark/client.ts`** (one dump, declares country support as unreported on both directions). For a multi-endpoint provider, copy `bvnk/client.ts` (three dumps). For discovered — not declared — country support, copy `mural/client.ts`.

## The data flow

```
_discoverRails ──fetch──▶ .ramp-rails/raw/<id>/*.json        (gitignored raw dumps)
distillRailSupport ──parse──▶ .ramp-rails/<id>.support.json  (committed snapshot)
rails:generate ──merge snapshots + declared consts──▶ ramp-support.generated.ts  (committed)
```

Raw dumps under `.ramp-rails/raw/` are gitignored — network scratch, safe to delete and re-fetch. The snapshot (`.ramp-rails/<id>.support.json`) and the generated `.ts` are both committed and must be regenerated together when your support changes.

## Step 1 — declare your dumps

Add an entry to `RAMP_RAIL_DUMPS` in `lib/ramps/shared.ts`, one per upstream response you need:

```ts
<id>: {
  currencies: { name: "<id>/currencies", file: dumpFile("<id>/currencies") },
},
```

`name` is what `_discoverRails` writes; `file` is what `distillRailSupport` reads back.

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

## Step 3 — `distillRailSupport`

Pure: given a `readDump` function, read the dump(s) back with `readDump(RAMP_RAIL_DUMPS.<id>.<key>.file)` and map into a `ProviderRailSupportSnapshot`:

```ts
interface ProviderRailSupportSnapshot {
  onramp: ProviderDirectionSupportSnapshot;
  offramp: ProviderDirectionSupportSnapshot;
}

interface ProviderDirectionSupportSnapshot {
  currencies: Record<string, { min: string | null; max: string | null }>;
  cryptos: readonly CryptoRailId[];
  countrySupport?: RampCountrySupport; // only set if you discover it — see step 4
}
```

Return it wrapped in a `ProviderRailSupportDistillation` — the snapshot plus any codes you had to drop:

```ts
export function distill<Id>RailSupport(raw: unknown): ProviderRailSupportDistillation {
  // parse `raw`, build currencies/cryptos/countrySupport, collect drops
  return { snapshot, droppedCurrencyCodes, droppedCountryCodes };
}
```

Keep the mapping in a standalone `distill<Id>RailSupport(raw)` (as above) so it's unit-testable without HTTP; the class's `distillRailSupport(readDump)` method just reads the dump and calls it.

Mapping rules (helpers live in `shared.ts`):

- **Crypto code → `CryptoRailId`** — Solana assets only today: `isSolanaCryptoAsset(code)` then `SOLANA_ASSET_TO_RAIL[code]` (e.g. `USDC` → `usdc.solana`). Skip anything else.
- **Fiat code → currency key** — validate with `isActiveIso4217CurrencyCode(code)`; codes that fail are dropped into `droppedCurrencyCodes`, not added to the snapshot. Uppercase ISO 4217 only.
- **Country code** — validate with `isIso3166Alpha2CountryCode(code)`; failures go into `droppedCountryCodes`.
- **Limits** — `{ min, max }` are major-unit decimal strings when the provider reports bounds; use `unreportedCurrencyLimit()` (`{ min: null, max: null }`) when it doesn't.
- Only populate `countrySupport` on the snapshot if you're genuinely discovering it from the dump (Mural derives per-currency country lists this way). If your provider doesn't report country coverage, leave it `undefined` here and declare it instead (step 4).

## Step 4 — declare what you don't discover

Every provider needs a `<PROVIDER>_DECLARED_RAIL_SUPPORT` const satisfying `ProviderDeclaredRailSupport`, assigned to `declaredRailSupport` on the class:

```ts
export const <PROVIDER>_DECLARED_RAIL_SUPPORT = {
  onramp: { entityTypes: ["individual"] },
  offramp: {
    countrySupport: { coverage: "unreported" },
    entityTypes: ["individual", "business"],
  },
} as const satisfies ProviderDeclaredRailSupport;
```

`entityTypes` (`CounterpartyEntityType[]`) is always declared here — it's never discovered from a dump. `countrySupport` is discovered **xor** declared, per direction: if your snapshot sets `countrySupport` for a direction, leave it off the declared const for that direction; if it doesn't (the common case — declare `{ coverage: "unreported" }`), it must be declared. `rails:generate` throws if a direction ends up with both or neither.

## Generate + verify

Fetching raw dumps hits live sandbox APIs, so it runs under Doppler. Regenerating from committed snapshots is pure and needs no creds:

```bash
# from apps/sdp-api — fetch raw dumps for every provider + distill their snapshots
pnpm --filter @sdp/api rails:discover
# just your provider
pnpm --filter @sdp/api rails:discover -- <id>
# re-distill from the existing raw dumps only — no network, no creds
pnpm --filter @sdp/api rails:discover -- <id> --offline

# regenerate ramp-support.generated.ts from the committed snapshots + declared consts
pnpm --filter @sdp/api rails:generate

# CI gate: regenerate in memory and byte-diff against the committed file
pnpm --filter @sdp/api rails:drift
```

Commit `.ramp-rails/<id>.support.json` and the regenerated `ramp-support.generated.ts` together (confirm your provider's row in `RAMP_PROVIDER_SUPPORT_COUNTS` looks sane). Never hand-edit the generated file. Never commit `.ramp-rails/raw/`.

## Rules

- HTTP only in `_discoverRails` — no DB, no business logic.
- `distillRailSupport` is pure over the dumps — no fetching. A malformed dump should throw, not silently yield empty support; unsupported currency/country codes get reported in `droppedCurrencyCodes`/`droppedCountryCodes`, not swallowed.
- No fallbacks: a missing cred throws via `requireEnv`.
- Strong typing: the declared-support const is `as const satisfies ProviderDeclaredRailSupport`; no `any`.
- Your provider must already be registered (`register-provider`) — the codegen iterates `RAMP_PROVIDERS` and will fail if a client is missing.
