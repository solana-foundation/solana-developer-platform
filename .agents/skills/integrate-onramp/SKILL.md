---
name: integrate-onramp
description: Implement a provider's fiat→crypto createOnrampQuote in @sdp/payments, extend the closed quote contract, and wire API persistence plus dashboard rendering.
disable-model-invocation: true
---

# Integrate on-ramp

On-ramp = a counterparty buys crypto with fiat, delivered to an SDP-known wallet. Implement `createOnrampQuote` on the package client and add a branch to the API quote dispatch. There is no `executeOnramp` method in the current provider contract.

`createOnrampQuote` is **optional** on `RampProvider` — implement it only if your provider has a lockable quote step.

Choose the closest package client: Lightspark/BVNK/Mural for manual instructions, MoonPay/Coinbase for hosted URLs, or Stripe/MoneyGram for session widgets. Provider-specific DB helpers live in `apps/sdp-api/src/routes/payments/handlers/ramps/<id>.ts`.

## Contract

Read the current `RampOnrampQuoteInput` from `packages/sdp-payments/src/ramps/types.ts`. The handler resolves wallet, counterparty, identity/contact, and provider account ids before calling the package client; the client never reads the database.

`PaymentRampQuote` is a closed union discriminated by both `provider` and `deliveryMode` in `packages/sdp-types/src/payments.ts`. Add the provider-specific quote arm, and add a `PaymentRampInstruction` arm for new manual instruction fields:

- `deliveryMode: "manual_instructions"` — return `paymentInstructions` (bank/wire or on-chain funding details). Lightspark, BVNK, Mural.
- `deliveryMode: "hosted"` — return a `hostedUrl` the client renders (widget/redirect). MoonPay.
- `deliveryMode: "session_widget"` — return the session fields required by an embedded SDK/frame. Stripe, MoneyGram.

Prefer the upstream quote/session id. If the upstream does not mint one, use `rampId("ramp_quote")` from `@sdp/payments/ramps/shared` and pass that reference upstream. The webhook or reconciliation path must return the same reference.

## Handler wiring (the DB side)

Add a branch to `apps/sdp-api/src/routes/payments/handlers/ramps.ts`. The handler owns all DB work:

- resolves the counterparty + destination wallet,
- ensures any provider-side customer/account exists (DB-touching `ensure*` helpers live in `apps/sdp-api/src/routes/payments/handlers/ramps/<id>.ts`, like `ensureLightsparkCustomer`),
- calls your HTTP-only `createOnrampQuote` with pre-resolved inputs,
- persists the transfer via `persistRampQuoteTransfer` (dedups by `(provider, providerReference)`; `rampQuoteTransferStatus` maps a `manual_instructions` + `pending` quote to `awaiting_payment`).

Runtime route: `POST /v1/payments/ramps/onramp/quote`, gated by provider availability, metered quota, permissions, and `policyGate`. This route is public OpenAPI today; update `apps/sdp-api/src/openapi/**` when the new provider changes its request/response shape and regenerate owned artifacts.

For `hosted`, decide whether the upstream permits iframe embedding or requires a top-level redirect. Check the provider's CSP / `frame-ancestors` policy and return/render the URL accordingly; the dashboard's generic non-Coinbase hosted path currently uses `MoonpayRampFrame`, so a redirect-only provider needs an explicit renderer instead of inheriting that path.

## Variety

| Provider | deliveryMode | On-ramp quote shape |
|---|---|---|
| Lightspark | `manual_instructions` | `REALTIME_FUNDING` quote; funding `paymentInstructions` |
| BVNK | `manual_instructions` | bank pay-in instructions built from the provisioned rule |
| Mural | `manual_instructions` | pay-in instructions for the resolved account |
| MoonPay | `hosted` | signed `buy.moonpay.com` widget `hostedUrl` |
| Stripe / MoneyGram | `session_widget` | embedded provider session credentials |

## Gating — throw, don't fallback

A provider that needs provisioning must fail loud when it's missing: Lightspark throws if `customerId` is absent; BVNK throws `counterpartyNotProvisioned` if the customer isn't verified or the rule isn't ready. Getting the counterparty to a ready state is `counterparty-requirements` — never substitute a default.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- No fallbacks — missing customer/account/instructions throws; never default them.
- HTTP in the provider; DB (counterparty, wallet, customer, transfer row) in the handler.
- `deliveryMode` arms are a real discriminated union — return exactly one arm's fields; no `any`.
- Update `apps/sdp-web/src/app/dashboard/payments/ramps/` when the provider's quote arm or instruction shape is not already rendered by the chosen delivery mode.
- Verify `@sdp/payments`, focused API quote/persistence tests, OpenAPI generation when changed, and `sdp-web` typecheck/tests for the renderer.
