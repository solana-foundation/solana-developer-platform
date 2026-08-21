---
name: integrate-offramp
description: Implement a ramp provider's crypto→fiat off-ramp quote — createOfframpQuote (required) → PaymentRampQuote — and wire the handler dispatch that resolves the source wallet and payout account. Use when opening a PR against apps/sdp-api to add off-ramp support for a ramp provider.
disable-model-invocation: true
---

# Integrate off-ramp

Off-ramp = a counterparty sells crypto for fiat paid to their bank account. `createOfframpQuote` is the whole SDP-owned flow: you implement it and add a `case` to the off-ramp quote dispatch. There is deliberately no execute endpoint on `RampProvider` — see `integrate-onramp` for why.

`createOfframpQuote` is **required** on `RampProvider` (unlike `createOnrampQuote`, which is optional) — even a provider that doesn't support off-ramp must implement it; the dispatch `case` for that provider can throw instead of calling it (Mural, Coinbase, and Stripe all currently throw "not supported" from the handler rather than reaching the client method).

Canonical example: `createOfframpQuote` in `packages/sdp-payments/src/ramps/providers/lightspark/client.ts` + `apps/sdp-api/src/routes/payments/handlers/ramps/lightspark.ts`.

## Contract

Input `RampOfframpQuoteInput` (`packages/sdp-payments/src/ramps/types.ts`): `{ cryptoToken, fiatCurrency?, cryptoAmount, sourceWalletAddress, paymentTransferId?, externalCustomerId, customerId?, payoutAccountId?, bvnkOfframpWalletId?, redirectUrl?, bvnkCompliance? }`. The handler pre-resolves `customerId`, `payoutAccountId`, and (for BVNK) `paymentTransferId` / `bvnkOfframpWalletId`.

Output `PaymentRampQuote` — same discriminated-union-on-`deliveryMode` shape as on-ramp (see `integrate-onramp`).

## Two off-ramp-specific resolutions (handler-side)

1. **Source wallet.** Off-ramp draws crypto from a wallet. The handler resolves the address via `resolveWalletAddress`, then gates the attempt through `enforceRampWalletOperationPolicy` (a **Wallet Operation** evaluated against the source wallet's **Wallet Policy** before any provider call). Every off-ramp provider goes through this same gate — there's no per-provider exception.

2. **Payout account.** The fiat needs a destination bank account. Lightspark resolves `payoutAccountId` from the counterparty's most recent active account (`latestLightsparkPayoutAccount`), JIT-created by `ensureLightsparkPayoutAccount` — content-addressed by a hash of the collected bank details, and **the raw bank details are sent to the provider and never stored**. That provisioning is `counterparty-requirements`; the quote consumes the resolved id and throws `counterpartyNotProvisioned` if it's missing or inactive.

## Handler wiring (the DB side)

Add a `case "<id>"` to the off-ramp quote dispatch in `apps/sdp-api/src/routes/payments/handlers/ramps.ts` (`createOfframpQuote`). The handler resolves counterparty + source wallet + payout account, calls your HTTP-only method, and persists via `persistRampQuoteTransfer` (off-ramp writes `sourceAddress` + `cryptoAmount`, `direction: "outbound"`).

Route: `POST /v1/ramps/offramp/quote`, gated by `assertRampProviderAvailable` + `payments:write` / `wallets:read`.

## Variety

| Provider | deliveryMode | Off-ramp quote shape |
|---|---|---|
| Lightspark | `manual_instructions` | `REALTIME_FUNDING` quote: customer sends crypto to the instructions, the provider auto-executes into the payout account |
| BVNK | `manual_instructions` | estimate → accept; carries `bvnkCompliance` (requester IP, etc.) |
| MoonPay | `hosted` | signed `sell.moonpay.com` widget `hostedUrl` |
| MoneyGram | `session_widget` | short-lived session JWT + `widgetUrl` |

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- No fallbacks — missing/inactive payout account or customer throws; never default them.
- HTTP in the provider; DB (wallet resolution, payout account, transfer row) in the handler.
- Bank details are transient — passed to the provider, never persisted to `provider_data`.
- Verify with `tsc --noEmit` + `biome check`; mock fetch in `apps/sdp-api/src/lib/ramps/providers/<id>/client.test.ts`.
