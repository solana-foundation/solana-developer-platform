---
name: integrate-webhook
description: Implement and register a ramp WebhookProcessor in sdp-api with raw-request verification, replay protection, typed @sdp/payments parsing, and idempotent settlement.
disable-model-invocation: true
---

# Integrate webhook

Webhooks drive a transfer toward settlement after the quote. Provider `settled`
only reaches `settling`; `verify-ramp-deliveries` checks the chain before
`completed`. Follow `docs/contributing/ramp-provider-safety.md`. Implement one
`WebhookProcessor` in `apps/sdp-api/src/services/ramps/webhooks/<id>.ts` using
the interface in `processor.ts`:

- `verify(context)` — verify the raw request signature, return the raw body.
- `parse(rawBody, environment)` — pure wire-format → `RampSettlementEvent` mapping.
- `process(env, environment, event)` — DB orchestration through `applyRampSettlementEvent`.

Canonical examples: the registered processors in
`apps/sdp-api/src/services/ramps/webhooks/`.

## Mount + flow

Webhooks are **not** under `/v1`. They land at
`POST /webhooks/payments/ramps/{sandbox|production}/:provider`.
`parseRampWebhookProvider` accepts an id only after registration in
`apps/sdp-api/src/services/ramps/webhooks/registry.ts`. The handler verifies
the raw body and persists it in the durable inbox before its 2xx response.
The same typed processor handles the background apply and replay.

## verify

`verify(context: RampWebhookValidationContext): Promise<string>`. `context` =
`{ env, environment, headers, rawBody, requestUrl? }`. Read the mode-keyed
verification key, verify the signature over the **raw** body, and return that
body. Throw `UNAUTHORIZED` on a missing or invalid signature. Use
`apps/sdp-api/src/lib/webhook-signature.ts` with the provider-signed timestamp.

The shared verifier currently supports HMAC-SHA256, and it requires a provider-signed timestamp. If the upstream uses another algorithm or does not sign a timestamp, stop and extend/review the shared verification contract; do not fabricate a local timestamp or bypass replay protection.

This is one of the few places `unknown` is allowed — it's a genuine trust boundary, narrowed immediately by `parse`.

Signature variety across the registered webhook providers:

| Provider | Header | Algorithm | Env keys |
|---|---|---|---|
| MoonPay | `moonpay-signature-v2` | HMAC-SHA256 (hex, `t=…,s=…`) | `MOONPAY_SANDBOX_WEBHOOK_KEY` (sandbox only) |
| Stripe | `stripe-signature` | HMAC-SHA256 (hex, `t=…,v1=…`) | `STRIPE_SANDBOX_WEBHOOK_SECRET` (sandbox only; events must carry `livemode: false`) |

## parse

`(rawBody: string, environment?: SdpEnvironment) → Event`, typically
`RampSettlementEvent` from `@sdp/payments/ramps/types`. Validate the provider
envelope and event types; unknown event types map to `ignore`. Set `reference`
to the provider transaction or session id bound to the SDP quote. Parse amounts
in their real currency: a MoonPay buy's `quoteCurrencyAmount` is crypto, while
a sell's `quoteCurrencyAmount` is fiat. Keep refund wallets distinct from
on-chain sending wallets.

Signed but irrelevant events should map to `ignore`; malformed provider
envelopes should fail loudly. The durable inbox classifies sandbox and
production failures differently, so preserve that path for every provider.

`RampSettlementEvent` (`packages/sdp-payments/src/ramps/types.ts`) has
`awaiting_payment`, `settling`, `settled`, `failed`, `expired`, and `ignore`
kinds. `receivedAmount` is a major-unit string: crypto for a settled on-ramp,
fiat for a settled off-ramp. Carry the provider's chain signature and any
reported destination in `onchain`; keep refund addresses separate.

## process

`process(env, environment, event)` is thin:

```ts
async process(env: Env, environment: SdpEnvironment, event: RampSettlementEvent) {
  return applyRampSettlementEvent(env, environment, event);
}
```

Register the processor in `RAMP_PROVIDER_WEBHOOK_PROCESSOR` in
`apps/sdp-api/src/services/ramps/webhooks/registry.ts`.
`applyRampSettlementEvent` verifies correlation and environment, then stores
provider observations separately from quoted fields. A settled event stays
`settling` until `verify-ramp-deliveries` proves the delivery on chain.

## Beyond settlement: provisioning auto-advance

A provider whose counterparty provisioning is async (KYC verification, wallet creation) also moves requirement state from webhooks: `parse` returns a wider provider event union — one event kind per upstream type (customer status changes, wallet creation/status changes, payment status changes) — and `process` switches exhaustively on `event.kind`, routing settlement kinds to `applyRampSettlementEvent`-based helpers and provisioning kinds to helpers that update `counterparty_provider_accounts` rows (never `counterparties.provider_data` — it's deprecated). The requirements GET then reflects the advanced state (`counterparty-requirements`). The standard contract a new provider implements is the settlement path above; add provisioning kinds only when the upstream provisions asynchronously.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- Verify the signature before trusting anything; never skip on a missing header — throw `UNAUTHORIZED`.
- No swallowed errors in your own logic; the orchestration owns the 2xx + background write.
- Event-type maps are `as const satisfies Record<string, RampSettlementEvent["kind"]>`; no `any` past the `verify` boundary.
- Verify focused webhook tests for valid, missing, malformed, stale, and replayed signatures; unknown events; duplicate terminal delivery; and settlement persistence. Run API typecheck/tests plus `@sdp/payments` checks when event types change.
