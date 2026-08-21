---
name: integrate-onramp
description: Implement a ramp provider's fiat→crypto on-ramp quote — createOnrampQuote → PaymentRampQuote — and wire the handler dispatch that resolves DB state. Use when opening a PR against apps/sdp-api to add on-ramp support for a ramp provider.
disable-model-invocation: true
---

# Integrate on-ramp

On-ramp = a counterparty buys crypto with fiat, delivered to an SDP-known wallet. `createOnrampQuote` is the whole SDP-owned flow — it returns a **Ramp Quote**, priced just-in-time. There is deliberately no execute endpoint on `RampProvider`: the quote hands off to the provider's own flow (hosted redirect, embedded widget, or deposit instructions) for the counterparty to complete.

`createOnrampQuote` is **optional** on `RampProvider` — implement it only if your provider has a lockable quote step.

Canonical example: `createOnrampQuote` in `packages/sdp-payments/src/ramps/providers/lightspark/client.ts` + the DB helpers in `apps/sdp-api/src/routes/payments/handlers/ramps/lightspark.ts`.

## Contract

Input `RampOnrampQuoteInput` (`packages/sdp-payments/src/ramps/types.ts`): `{ cryptoToken, fiatCurrency?, fiatAmount, destinationWalletAddress, externalCustomerId, customerId?, redirectUrl?, bvnkCompliance?, email?, phone?, domain?, customerIpAddress?, stripeCustomerInfo? }` — the trailing fields are provider-specific (Coinbase, Stripe); add your own if you need something none of them cover. The handler pre-resolves `customerId` / `externalCustomerId` from the DB — your method never reads the database.

`PaymentRampQuote` is a **discriminated union on `provider` and `deliveryMode`** (`packages/sdp-types/src/payments.ts`) — return the arm that matches your product:

- `deliveryMode: "manual_instructions"` — return `paymentInstructions` (bank/wire or on-chain funding details). Lightspark, BVNK, Mural.
- `deliveryMode: "hosted"` — return a `hostedUrl` the client renders (widget/redirect). MoonPay, BVNK, Coinbase.
- `deliveryMode: "session_widget"` — return a short-lived session token/secret plus a widget URL the client mounts inline. MoneyGram, Stripe.

Set `id` to the upstream quote id when the provider returns one, so the webhook can match the transfer later (`integrate-webhook`) — Lightspark does this. If there's no upstream quote id to key off (a hosted widget with no pre-created quote), mint one with `rampId("ramp_quote")` (`packages/sdp-payments/src/ramps/shared.ts`) — MoonPay does this.

## Handler wiring (the DB side)

Add a `case "<id>"` to the on-ramp quote dispatch in `apps/sdp-api/src/routes/payments/handlers/ramps.ts` (`createOnrampQuote`). The handler owns all DB work:

- resolves the counterparty + destination wallet,
- ensures any provider-side customer/account exists (DB-touching `ensure*` helpers live in `apps/sdp-api/src/routes/payments/handlers/ramps/<id>.ts`, like `ensureLightsparkCustomer`),
- calls your HTTP-only `createOnrampQuote` with pre-resolved inputs,
- persists the transfer via `persistRampQuoteTransfer` (dedups by `(provider, providerReference)`; `rampQuoteTransferStatus` maps a `manual_instructions` + `pending` quote to `awaiting_payment`).

Route: `POST /v1/ramps/onramp/quote`, gated by `assertRampProviderAvailable` + `payments:write` / `wallets:read`.

## Variety

| Provider | deliveryMode | On-ramp quote shape |
|---|---|---|
| Lightspark | `manual_instructions` | `REALTIME_FUNDING` quote; funding `paymentInstructions` |
| BVNK | `manual_instructions` | bank pay-in instructions built from the provisioned rule |
| Mural | `manual_instructions` | pay-in instructions for the resolved account |
| MoonPay | `hosted` | signed `buy.moonpay.com` widget `hostedUrl` |
| Coinbase | `hosted` | headless create-order `hostedUrl` plus order economics |
| MoneyGram | `session_widget` | short-lived session JWT + `widgetUrl` |
| Stripe | `session_widget` | embedded on-ramp `clientSecret` + `publishableKey` |

## Gating — throw, don't fallback

A provider that needs provisioning must fail loud when it's missing: Lightspark throws if `customerId` is absent; BVNK throws `counterpartyNotProvisioned` if the customer isn't verified or the rule isn't ready. Getting the counterparty to a ready state is `counterparty-requirements` — never substitute a default.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- No fallbacks — missing customer/account/instructions throws; never default them.
- HTTP in the provider; DB (counterparty, wallet, customer, transfer row) in the handler.
- `deliveryMode` arms are a real discriminated union — return exactly one arm's fields; no `any`.
- Verify with `tsc --noEmit` + `biome check`; mock fetch in `apps/sdp-api/src/lib/ramps/providers/<id>/client.test.ts` (provider calls 503 without creds in the environment).
