---
name: integrate-estimate
description: Implement a ramp provider's estimateOnramp / estimateOfframp → PaymentRampEstimate, the fiat↔crypto rate preview. The cheapest live call — no DB, no counterparty, no KYC — so build it first to prove your config and auth work. Use when opening a PR against apps/sdp-api to add ramp rate estimates for a provider.
---

# Integrate estimate

An estimate is a rate preview: "how much USDC for 100 EUR?" It hits the provider's live rate API and nothing else — no counterparty, no wallet, no DB. That makes it the first capability to build: if `estimateOnramp` works, your `register-provider` config reader and credentials are correct.

Canonical example: `estimateOnramp` / `estimateOfframp` in `lib/ramps/providers/lightspark/client.ts`.

## Contract

Both methods are required on `RampProvider` (`lib/ramps/types.ts`):

```ts
estimateOnramp(ctx: RampRuntimeContext, input: RampEstimateOnrampInput): Promise<PaymentRampEstimate>
estimateOfframp(ctx: RampRuntimeContext, input: RampEstimateOfframpInput): Promise<PaymentRampEstimate>
```

Inputs (`lib/ramps/types.ts`):
- onramp: `{ assetRail: CryptoRailId, fiatCurrency: RampFiatCurrency, fiatAmount: string }`
- offramp: `{ assetRail: CryptoRailId, fiatCurrency: RampFiatCurrency, cryptoAmount: string }`

Output `PaymentRampEstimate` (`@sdp/types`, `packages/sdp-types/src/payments.ts`):

```ts
{
  provider; direction: "onramp" | "offramp";
  fiatCurrency; assetRail; fiatAmount; cryptoAmount; exchangeRate;  // all strings
  fees: { currency; total; network?; provider? };
  minFiatAmount?; maxFiatAmount?; expiresAt?;
}
```

## How to build it

`ctx` is `{ env, mode }` — read your config with the mode-keyed reader from `register-provider`, then HTTP only. Convert the asset rail to the provider's currency code with `getCryptoRailAssetLabel(input.assetRail)`; convert amounts to/from the provider's minor units with `parseDecimalAmount(str, decimals)` / `formatDecimalAmount(bigint, decimals)` (`lib/amount.ts`).

Lightspark's shape: GET the corridor's `exchange-rates` once to learn decimals, again with the amount to get the quote, then map into `PaymentRampEstimate`.

## Fail loud

A non-positive receiving amount is not a `0` estimate — it's a broken corridor. Throw, don't return zero:

```ts
if (rate.receivingAmount <= 0) {
  throw providerUnavailable("<Provider> returned a non-positive on-ramp receiving amount");
}
```

The **only** soft signal allowed here is declaring a pair genuinely unsupported: throw `new AppError("ESTIMATE_NOT_AVAILABLE", …)`. The estimate fan-out (`estimateAcrossProviders` in `routes/payments/handlers/ramps.ts`) catches that one code and reports the provider as `unsupported`; every other error surfaces. That's a typed signal, not a `?? 0`.

## Dispatch + route

Estimates fan out across all entitled providers at `POST /v1/ramps/{onramp|offramp}/estimate` (`routes/payments/handlers/ramps.ts` → `estimateAcrossProviders`, gated by `assertRampProviderAvailable`). You don't touch the fan-out — it calls `RAMP_PROVIDER_CLIENTS[provider].estimate*` for each provider that passes `filterProviders`.

## Variety

| Provider | How estimate is sourced |
|---|---|
| Lightspark | `GET exchange-rates?sourceCurrency=…&destinationCurrency=…` (corridor, then with amount) |
| MoonPay | `GET /v3/currencies/{code}/buy_quote` (on) / `sell_quote` (off) |
| BVNK | `POST` quote with `estimate=true` |

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- No fallbacks — non-positive/empty rate throws; never substitute a default amount or rate.
- HTTP only; no DB, no counterparty lookups in estimate.
- Strong typing — status/type maps are `as const satisfies Record<…>`; no `any`.
- Verify with `tsc --noEmit` + `biome check`. Provider calls 503 when credentials aren't present in the environment, so unit-test the mapping with mocked fetch, like `providers/lightspark/client.test.ts`.
