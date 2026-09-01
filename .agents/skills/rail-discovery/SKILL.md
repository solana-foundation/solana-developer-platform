---
name: rail-discovery
description: Declare which fiat↔crypto rails a ramp provider supports. Implement discovery or an explicit static distiller in @sdp/payments, then regenerate the committed provider snapshot and shared support matrix.
disable-model-invocation: true
---

# Rail discovery

The platform serves a generated support matrix — which `(fiat, crypto)` pairs each provider can on/off-ramp — from `packages/sdp-types/src/generated/ramp.generated.ts` (`ONRAMP_SUPPORT`, `OFFRAMP_SUPPORT`, `RAMP_FIAT_CURRENCIES`). You do **not** hand-edit that file. You teach your provider to report its rails, then a script distills live provider responses into a committed per-provider snapshot and merges every provider's snapshot into the matrix.

Implement rail support in `packages/sdp-payments`; the codegen (`apps/sdp-api/scripts/ramp-support.ts`) owns snapshots and the generated matrix. Choose one source:

1. **Upstream discovery API:** add `RAMP_RAIL_DUMPS.<id>` in `packages/sdp-payments/src/ramps/shared.ts`; `_discoverRails` writes raw responses; `distillRailSupport` reads and normalizes them.
2. **No discovery API:** make `_discoverRails` a no-op and return an explicit, tested snapshot from `distillRailSupport`. Do not invent a network endpoint or dump.

Both paths declare `<PROVIDER>_DECLARED_RAIL_SUPPORT` for entity types and country support not discovered in the snapshot. Reference Lightspark for one dump, BVNK for multiple endpoints, Mural for discovered country support, and Stripe for static support; all live under `packages/sdp-payments/src/ramps/providers/`.

## The data flow

```
_discoverRails ──fetch──▶ .ramp-support/raw/<id>/*.json        (gitignored raw dumps)
distillRailSupport ──parse──▶ .ramp-support/<id>.currency.json  (committed snapshot)
ramp-support:generate ──merge snapshots + declared consts──▶ ramp.generated.ts  (committed)
```

Raw dumps under `.ramp-support/raw/` are gitignored — network scratch, safe to delete and re-fetch. The snapshot (`.ramp-support/<id>.currency.json`) and the generated `.ts` are both committed and must be regenerated together when your support changes.

## Step 1 — choose the source

For discovery-backed support, add an entry to `RAMP_RAIL_DUMPS` in `packages/sdp-payments/src/ramps/shared.ts`, one per upstream response:

```ts
<id>: {
  currencies: { name: "<id>/currencies", file: dumpFile("<id>/currencies") },
},
```

`name` is what `_discoverRails` writes; `file` is what `distillRailSupport` reads back. For static support, skip the dump entry.

## Step 2 — `_discoverRails`

HTTP only. Read **sandbox** creds from the passed `env` with `requireEnv`, fetch each upstream endpoint with the injected `fetchJson`, and `writeDump` the raw response. No parsing or mapping here. For static support, use a no-op method and read no credentials.

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

Pure: map the dump(s), or an explicit static declaration, into the types from `packages/sdp-payments/src/ramps/types.ts`:

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
  onramp: {
    countrySupport: { coverage: "unreported" },
    entityTypes: ["individual"],
  },
  offramp: {
    countrySupport: { coverage: "unreported" },
    entityTypes: [],
  },
} as const satisfies ProviderDeclaredRailSupport;
```

`entityTypes` (`CounterpartyEntityType[]`) is always declared here — it's never discovered from a dump. `countrySupport` is discovered **xor** declared, per direction: if your snapshot sets `countrySupport` for a direction, leave it off the declared const for that direction; if it doesn't (the common case — declare `{ coverage: "unreported" }`), it must be declared. `ramp-support:generate` throws if a direction ends up with both or neither.

## Generate + verify

Fetching raw dumps hits live sandbox APIs, so it runs under Doppler. Regenerating from committed snapshots is pure and needs no creds:

```bash
# from apps/sdp-api — fetch raw dumps for every provider + distill their snapshots
pnpm --filter @sdp/api currencies:discover
# just your provider
pnpm --filter @sdp/api currencies:discover -- <id>
# re-distill existing dumps, or generate a static-provider snapshot whose distiller ignores dumps
pnpm --filter @sdp/api exec tsx scripts/ramp-support.ts discover <id> --offline

# regenerate ramp.generated.ts from the committed snapshots + declared consts
pnpm --filter @sdp/api ramp-support:generate

# CI gate: regenerate in memory and byte-diff against the committed file
pnpm --filter @sdp/api ramp-support:drift
```

Commit `.ramp-support/<id>.currency.json` and the regenerated `ramp.generated.ts` together (confirm your provider's row in `RAMP_PROVIDER_SUPPORT_COUNTS` looks sane). Never hand-edit the generated file. Never commit `.ramp-support/raw/`.

## Rules

- HTTP only in `_discoverRails` — no DB, no business logic.
- `distillRailSupport` is pure over the dumps — no fetching. A malformed dump should throw, not silently yield empty support; unsupported currency/country codes get reported in `droppedCurrencyCodes`/`droppedCountryCodes`, not swallowed.
- No fallbacks: a missing cred throws via `requireEnv`.
- Strong typing: the declared-support const is `as const satisfies ProviderDeclaredRailSupport`; no `any`.
- Your provider must already be registered (`register-provider`) — the codegen iterates `RAMP_PROVIDERS` and will fail if a client is missing.
- Verify with `pnpm --filter @sdp/api ramp-support:drift`, plus `@sdp/payments` typecheck, lint, and tests.
