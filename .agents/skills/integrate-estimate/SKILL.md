---
name: integrate-estimate
description: Implement a ramp provider's estimateOnramp / estimateOfframp → PaymentRampEstimate in @sdp/payments. The cheapest live provider call, with no DB, counterparty, or KYC.
disable-model-invocation: true
---

# Integrate estimate

An estimate is a rate preview: "how much USDC for 100 EUR?" It hits the provider's live rate API and nothing else — no counterparty, no wallet, no DB. That makes it the first capability to build: if `estimateOnramp` works, your `register-provider` config reader and credentials are correct.

Choose the closest implementation in `packages/sdp-payments/src/ramps/providers/`: Lightspark for decimal/minor-unit conversion, MoonPay for hosted-provider quote APIs, Stripe for on-ramp-only support, or BVNK for POST-based estimates.

## Contract

Both methods are required on `RampProvider` (`packages/sdp-payments/src/ramps/types.ts`), even when one direction is unsupported:

```ts
estimateOnramp(ctx: RampRuntimeContext, input: RampEstimateOnrampInput): Promise<PaymentRampEstimate>
estimateOfframp(ctx: RampRuntimeContext, input: RampEstimateOfframpInput): Promise<PaymentRampEstimate>
```

Inputs (`packages/sdp-payments/src/ramps/types.ts`):
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

`ctx` is `{ env, mode }` — read your config with the mode-keyed reader from `register-provider`, then HTTP only. Convert the asset rail with `getCryptoRailAssetLabel` from `@sdp/types/payment-rails`; convert minor units with `parseDecimalAmount` / `formatDecimalAmount` from `@sdp/solana/amount`.

Lightspark's shape: GET the corridor's `exchange-rates` once to learn decimals, again with the amount to get the quote, then map into `PaymentRampEstimate`.

## Fail loud

A non-positive receiving amount is not a `0` estimate — it's a broken corridor. Throw, don't return zero:

```ts
if (rate.receivingAmount <= 0) {
  throw providerUnavailable("<Provider> returned a non-positive on-ramp receiving amount");
}
```

For an unsupported pair/direction, or a provider whose price exists only at hosted-quote time, throw `estimateNotAvailable(...)` from `@sdp/payments/errors`. The API fan-out maps that code to `{ status: "unsupported" }`; it maps every other provider exception to `{ status: "error", error }` for that provider, so one failed provider does not fail the whole fan-out.

## Dispatch + route

The dashboard runtime routes are `POST /v1/payments/ramps/{onramp|offramp}/estimate` (`apps/sdp-api/src/routes/payments/handlers/ramps.ts` → `estimateAcrossProviders`). They are availability-gated and metered. They are not currently part of the public OpenAPI surface, so do not advertise them as public endpoints unless the OpenAPI policy changes.

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
- Verify with `pnpm --filter @sdp/payments typecheck`, `lint`, and `test`, plus focused API fan-out tests when orchestration changes. Unit-test provider mapping with mocked fetch and cover unsupported directions and missing credentials.
