---
name: integrate-onramp
description: Implement a ramp provider's fiat→crypto on-ramp quote — createOnrampQuote → PaymentRampQuote — and wire the handler dispatch that resolves DB state. Use when opening a PR against apps/sdp-api to add on-ramp support for a ramp provider.
---

# Integrate on-ramp

On-ramp = a counterparty buys crypto with fiat, delivered to an SDP-known wallet. The active flow is the **quote**: you implement `createOnrampQuote` on your provider and add a `case` to the quote dispatch. (`executeOnramp` exists on the interface but isn't currently exercised — skip it for now; the quote returns the payment instructions the user acts on.)

`createOnrampQuote` is **optional** on `RampProvider` — implement it only if your provider has a lockable quote step.

Canonical example: `createOnrampQuote` in `lib/ramps/providers/lightspark.ts` + the DB helpers in `routes/payments/handlers/ramps/lightspark.ts`.

## Contract

Input `RampOnrampQuoteInput` (`lib/ramps/types.ts`): `{ cryptoToken, fiatCurrency?, fiatAmount, destinationWalletAddress, externalCustomerId, customerId?, redirectUrl?, bvnkCompliance? }`. The handler pre-resolves `customerId` / `externalCustomerId` from the DB — your method never reads the database.

`PaymentRampQuote` is a **discriminated union on `deliveryMode`** (`packages/sdp-types/src/payments.ts`) — return the arm that matches your product:

- `deliveryMode: "manual_instructions"` — return `paymentInstructions` (bank/wire or on-chain funding details). Lightspark, BVNK.
- `deliveryMode: "hosted"` — return a `hostedUrl` the client renders (widget/redirect). MoonPay.

Use `rampId("ramp")` for ids; set `id` to the upstream quote id so the webhook can match the transfer later (`integrate-webhook`).

## Handler wiring (the DB side)

Add a `case "<id>"` to the on-ramp quote dispatch in `routes/payments/handlers/ramps.ts`. The handler owns all DB work:

- resolves the counterparty + destination wallet,
- ensures any provider-side customer/account exists (DB-touching `ensure*` helpers live in `routes/payments/handlers/ramps/<id>.ts`, like `ensureLightsparkCustomer`),
- calls your HTTP-only `createOnrampQuote` with pre-resolved inputs,
- persists the transfer via `persistRampQuoteTransfer` (dedups by `(provider, providerReference)`; `rampQuoteTransferStatus` maps a `manual_instructions` + `pending` quote to `awaiting_payment`).

Route: `POST /v1/ramps/onramp/quote`, gated by `assertRampProviderAvailable` + `payments:write` / `wallets:read`.

## Variety

| Provider | deliveryMode | On-ramp quote shape |
|---|---|---|
| Lightspark | `manual_instructions` | `REALTIME_FUNDING` quote; funding `paymentInstructions` |
| BVNK | `manual_instructions` | bank pay-in instructions built from the provisioned rule |
| MoonPay | `hosted` | signed `buy.moonpay.com` widget `hostedUrl` |

## Gating — throw, don't fallback

A provider that needs provisioning must fail loud when it's missing: Lightspark throws if `customerId` is absent; BVNK throws `counterpartyNotProvisioned` if the customer isn't verified or the rule isn't ready. Getting the counterparty to a ready state is `counterparty-requirements` — never substitute a default.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- No fallbacks — missing customer/account/instructions throws; never default them.
- HTTP in the provider; DB (counterparty, wallet, customer, transfer row) in the handler.
- `deliveryMode` arms are a real discriminated union — return exactly one arm's fields; no `any`.
- Verify with `tsc --noEmit` + `biome check`; mock fetch in `providers/<id>.test.ts` (provider calls 503 without creds in the environment).
