---
name: integrate-offramp
description: Implement a provider's crypto→fiat createOfframpQuote in @sdp/payments, extend the closed quote contract, and wire API wallet policy, persistence, and dashboard rendering.
disable-model-invocation: true
---

# Integrate off-ramp

Off-ramp = a counterparty sells crypto from an SDP wallet for fiat paid to a payout account. Implement `createOfframpQuote` and add a branch to the API dispatch. There is no `executeOfframp` method in the current provider contract.

`createOfframpQuote` is **required** on `RampProvider` (unlike `createOnrampQuote`, which is optional).

Choose the closest package client under `packages/sdp-payments/src/ramps/providers/`: Lightspark/BVNK for manual instructions and payout provisioning, or MoonPay for a hosted off-ramp.

## Contract

Read the current `RampOfframpQuoteInput` from `packages/sdp-payments/src/ramps/types.ts`. The handler resolves the SDP wallet address, counterparty, provider customer/account ids, and any caller-defined transfer reference before calling the package client.

Output `PaymentRampQuote` is closed by `provider` and `deliveryMode`; add the provider quote/instruction arm in `packages/sdp-types/src/payments.ts` as described by `integrate-onramp`.

## Two off-ramp-specific resolutions (handler-side)

1. **Source wallet.** The shared policy extraction resolves `sourceWallet` to an SDP wallet/address and gates the value-moving operation through `policyGate`. Do not accept a provider account id in place of the SDP source wallet.

2. **Payout account.** The fiat needs a destination bank account. Lightspark resolves `payoutAccountId` from the counterparty's most recent active account (`latestLightsparkPayoutAccount`), JIT-created by `ensureLightsparkPayoutAccount` — content-addressed by a hash of the collected bank details, and **the raw bank details are sent to the provider and never stored**. That provisioning is `counterparty-requirements`; the quote consumes the resolved id and throws `counterpartyNotProvisioned` if it's missing or inactive.

## Handler wiring (the DB side)

Add a branch to `apps/sdp-api/src/routes/payments/handlers/ramps.ts`. The handler resolves counterparty + source wallet + payout account, calls the HTTP-only package method, and persists via `persistRampQuoteTransfer` (off-ramp writes `sourceAddress` + `cryptoAmount`, `direction: "outbound"`).

Dashboard runtime route: `POST /v1/payments/ramps/offramp/quote`, gated by provider availability, metered quota, permissions, and `policyGate`. It is not currently in public OpenAPI; do not advertise it as public unless the OpenAPI policy changes.

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
- Update the dashboard renderer if the provider's quote/instruction arm is not already supported.
- Verify `@sdp/payments`, focused API wallet-policy/persistence tests, and `sdp-web` checks for any renderer change.
