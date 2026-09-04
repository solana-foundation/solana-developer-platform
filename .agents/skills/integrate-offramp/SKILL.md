---
name: integrate-offramp
description: Implement a provider's crypto→fiat createOfframpQuote in @sdp/payments, extend the closed quote contract, and wire API wallet policy, persistence, and dashboard rendering.
disable-model-invocation: true
---

# Integrate off-ramp

Off-ramp = a counterparty sells crypto from an SDP wallet for fiat paid to a payout account. Implement `createOfframpQuote` and add a branch to the API dispatch. There is no `executeOfframp` method in the current provider contract.

`createOfframpQuote` is **required** on `RampProvider` (unlike `createOnrampQuote`, which is optional) — even a provider that doesn't support off-ramp must implement it; the dispatch `case` for that provider can throw instead of calling it (several registered providers do exactly that today rather than reaching the client method).

Choose the closest package client under `packages/sdp-payments/src/ramps/providers/` by delivery mode: manual instructions with payout provisioning, a hosted widget, or a session widget.

## Contract

Read the current `RampOfframpQuoteInput` from `packages/sdp-payments/src/ramps/types.ts`. The handler resolves the SDP wallet address, counterparty, provider customer/account ids, and any caller-defined transfer reference before calling the package client.

Output `PaymentRampQuote` is closed by `provider` and `deliveryMode`; add the provider quote/instruction arm in `packages/sdp-types/src/payments.ts` as described by `integrate-onramp`.

## Two off-ramp-specific resolutions (handler-side)

1. **Source wallet.** The shared policy extraction resolves `sourceWallet` to an SDP wallet/address and gates the value-moving operation through `policyGate`. Do not accept a provider account id in place of the SDP source wallet.

2. **Payout account.** The fiat needs a destination bank account, and a counterparty may hold several active accounts per corridor (per rail). The quote request takes an optional `providerAccountId` (the `counterparty_provider_accounts` row id): when present, the handler resolves it parent-scoped and rejects a mismatched corridor; when absent, it lists the corridor's active rows and applies the provider's selection helper. Accounts are JIT-created by the requirements advance flow — **the raw bank details are sent to the provider and never stored**. Missing/inactive account throws `counterpartyNotProvisioned`; the transfer records the chosen row id as `payoutProviderAccountId` in its provider data.

## Handler wiring (the DB side)

Add a branch to `apps/sdp-api/src/routes/payments/handlers/ramps.ts`. The handler resolves counterparty + source wallet + payout account, calls the HTTP-only package method, and persists the transfer. A `reservedTransferId` is minted before the provider call so it can travel upstream as the reference (pass it in a description/reference field where the upstream accepts one); persistence then takes one of two paths: default `persistRampQuoteTransfer` after the quote (off-ramp writes `sourceAddress` + `cryptoAmount`, `direction: "outbound"`, plus `providerData` such as `payoutProviderAccountId`), or a pending transfer created **before** the provider call and completed/failed after it (a `createPending*` → `completePending*` helper pair) when the provider call must be attributable to a row even on failure.

Dashboard runtime route: `POST /v1/payments/ramps/offramp/quote`, gated by provider availability, metered quota, permissions, and `policyGate`. It is not currently in public OpenAPI; do not advertise it as public unless the OpenAPI policy changes.

## Variety

| deliveryMode | Off-ramp quote shape |
|---|---|
| `manual_instructions` | on-chain funding instructions: the customer sends crypto to the instructions and the provider executes into the advance-provisioned payout destination (missing provisioning throws `counterpartyNotProvisioned`; some upstreams also require compliance party details on the quote) |
| `hosted` | signed provider widget `hostedUrl` |
| `session_widget` | short-lived session credentials + widget URL |

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- No fallbacks — missing/inactive payout account or customer throws; never default them.
- HTTP in the provider; DB (wallet resolution, payout account, transfer row) in the handler.
- Bank details are transient — passed to the provider, never persisted to `provider_data`.
- Update the dashboard renderer if the provider's quote/instruction arm is not already supported.
- Verify `@sdp/payments`, focused API wallet-policy/persistence tests, and `sdp-web` checks for any renderer change.
