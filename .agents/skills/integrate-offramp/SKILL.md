---
name: integrate-offramp
description: Implement a ramp provider's crypto→fiat off-ramp quote — createOfframpQuote (required) → PaymentRampQuote — and wire the handler dispatch that resolves the source wallet and payout account. Use when opening a PR against apps/sdp-api to add off-ramp support for a ramp provider.
---

# Integrate off-ramp

Off-ramp = a counterparty sells crypto for fiat paid to their bank account. The active flow is the **quote**: you implement `createOfframpQuote` and add a `case` to the off-ramp quote dispatch. (`executeOfframp` exists but isn't currently exercised — skip it for now.)

`createOfframpQuote` is **required** on `RampProvider` (unlike `createOnrampQuote`, which is optional).

Canonical example: `createOfframpQuote` in `lib/ramps/providers/lightspark/client.ts` + `routes/payments/handlers/ramps/lightspark.ts`.

## Contract

Input `RampOfframpQuoteInput` (`lib/ramps/types.ts`): `{ cryptoToken, fiatCurrency?, cryptoAmount, sourceWalletAddress, externalCustomerId, customerId?, payoutAccountId?, redirectUrl?, bvnkCompliance? }`. The handler pre-resolves `customerId` and `payoutAccountId`.

Output `PaymentRampQuote` — same discriminated-union-on-`deliveryMode` shape as on-ramp (see `integrate-onramp`).

## Two off-ramp-specific resolutions (handler-side)

1. **Source wallet.** Off-ramp draws crypto from a wallet. For SDP-wallet providers the handler resolves the address via `resolveWalletAddress` and runs `assertWalletPolicyAllowsTransfer`. Lightspark is the exception — its source is an upstream account id passed through as-is (the dispatch special-cases `input.provider === "lightspark"`). Follow whichever model your provider uses.

2. **Payout account.** The fiat needs a destination bank account. Lightspark resolves `payoutAccountId` from the counterparty's most recent active account (`latestLightsparkPayoutAccount`), JIT-created by `ensureLightsparkPayoutAccount` — content-addressed by a hash of the collected bank details, and **the raw bank details are sent to the provider and never stored**. That provisioning is `counterparty-requirements`; the quote consumes the resolved id and throws `counterpartyNotProvisioned` if it's missing or inactive.

## Handler wiring (the DB side)

Add a `case "<id>"` to the off-ramp quote dispatch in `routes/payments/handlers/ramps.ts`. The handler resolves counterparty + source wallet + payout account, calls your HTTP-only method, and persists via `persistRampQuoteTransfer` (off-ramp writes `sourceAddress` + `cryptoAmount`, `direction: "outbound"`).

Route: `POST /v1/ramps/offramp/quote`, gated by `assertRampProviderAvailable` + `payments:write` / `wallets:read`.

## Variety

| Provider | deliveryMode | Off-ramp quote shape |
|---|---|---|
| Lightspark | `manual_instructions` | `REALTIME_FUNDING` quote: customer sends crypto to the instructions, the provider auto-executes into the payout account |
| BVNK | `manual_instructions` | estimate → accept; carries `bvnkCompliance` (requester IP, etc.) |
| MoonPay | `hosted` | signed `sell.moonpay.com` widget `hostedUrl` |

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- No fallbacks — missing/inactive payout account or customer throws; never default them.
- HTTP in the provider; DB (wallet resolution, payout account, transfer row) in the handler.
- Bank details are transient — passed to the provider, never persisted to `provider_data`.
- Verify with `tsc --noEmit` + `biome check`; mock fetch in `providers/<id>/client.test.ts`.
