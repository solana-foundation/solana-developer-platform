---
name: integrate-webhook
description: Implement and register a ramp WebhookProcessor in sdp-api with raw-request verification, replay protection, typed @sdp/payments parsing, and idempotent settlement.
disable-model-invocation: true
---

# Integrate webhook

Webhooks drive a transfer's lifecycle after the quote: `awaiting_payment → settling → completed | failed | expired`. Implement one `WebhookProcessor` in `apps/sdp-api/src/routes/webhooks/ramps/<id>.ts` using the interface in `processor.ts`:

- `verify(context)` — verify the signature, return the parsed payload.
- `parse(payload)` — pure wire-format → `RampSettlementEvent` mapping.
- `process(c, environment, event)` — DB orchestration; calls `applyRampSettlementEvent`.

Canonical example: `LightsparkWebhookProcessor` in `apps/sdp-api/src/routes/webhooks/ramps/lightspark.ts`.

## Mount + flow

Webhooks are **not** under `/v1`. They land at `POST /webhooks/payments/ramps/{sandbox|production}/:provider`. `parseRampWebhookProvider` accepts an id only after registration in `apps/sdp-api/src/routes/webhooks/handlers.ts`. The handler reads the raw body → verifies → parses → returns 2xx → runs `process` through `c.executionCtx.waitUntil`.

## verify

`verify(context: RampWebhookValidationContext): Promise<Payload>`. `context` = `{ env, environment, headers, rawBody, requestUrl? }`. Read the mode-keyed verification secret/key from `env`, verify the signature over the **raw** body, then `JSON.parse` and return the payload. Throw `UNAUTHORIZED` on a missing/invalid signature; throw `badRequest` on non-JSON. Use `apps/sdp-api/src/lib/webhook-signature.ts` and supply the upstream timestamp as `timestampSeconds`; the helper enforces replay tolerance as well as signature verification.

The shared verifier currently supports HMAC-SHA256 and ECDSA P-256/SHA-256, and it requires a provider-signed timestamp. If the upstream uses another algorithm or does not sign a timestamp, stop and extend/review the shared verification contract; do not fabricate a local timestamp or bypass replay protection.

This is one of the few places `unknown` is allowed — it's a genuine trust boundary, narrowed immediately by `parse`.

Signature variety across the six registered webhook providers:

| Provider | Header | Algorithm | Env keys |
|---|---|---|---|
| Lightspark | `x-grid-signature` | ECDSA P-256 / SHA-256 (public key) | `LIGHTSPARK_GRID_WEBHOOK_PUBLIC_KEY` / `LIGHTSPARK_GRID_SANDBOX_WEBHOOK_PUBLIC_KEY` |
| MoonPay | `moonpay-signature-v2` | HMAC-SHA256 (hex, `t=…,s=…`) | `MOONPAY_WEBHOOK_KEY` / `MOONPAY_SANDBOX_WEBHOOK_KEY` |
| BVNK | `x-signature` | HMAC-SHA256 (base64) | `BVNK_WEBHOOK_SECRET` / `BVNK_SANDBOX_WEBHOOK_SECRET` |
| Coinbase | `x-hook0-signature` | HMAC-SHA256 (hex, `t=…,v0=…`) | `COINBASE_CDP_RAMPS_WEBHOOK_SECRET` |
| Mural | `x-mural-webhook-signature` + timestamp header | ECDSA P-256 / SHA-256 (public key, base64) | `MURAL_PAY_WEBHOOK_PUBLIC_KEY` / `MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY` |
| Stripe | `stripe-signature` | HMAC-SHA256 (hex, `t=…,v1=…`) | `STRIPE_WEBHOOK_SECRET` |

## parse

`(payload: Payload) → Event`, typically `RampSettlementEvent` from `@sdp/payments/ramps/types`. Narrow the payload with `readString` / `readRecord` / `readNumber` from `@sdp/payments/json`. Map upstream event types to `kind`, and set `reference` to the quote id persisted by SDP; that is how settlement finds the transfer. Anything legitimately signed but irrelevant maps to `{ provider, kind: "ignore", reason }`.

`parse` runs synchronously **before** the 2xx ack, so it must be total over every payload the provider can legitimately sign: unknown event types and transactions the platform didn't create (sandbox tests, manual payments on the same account) must map to an `ignore` event or an absent reference — never a throw, which turns into a non-2xx and a provider retry loop. Reserve throws for payloads that violate the provider's own guaranteed envelope (e.g. a missing event type), where a loud deterministic failure is the point. Example: BVNK channel references not minted by SDP return `undefined` from `readBvnkOfframpReference` and get logged-and-skipped in `process`.

`RampSettlementEvent` (`packages/sdp-payments/src/ramps/types.ts`):

```

`receivedAmount` is a major/display-unit string. For a settled on-ramp it is the received crypto amount; for an off-ramp it is the received fiat amount.
| { kind: "awaiting_payment"; provider; reference }
| { kind: "settling";         provider; reference }
| { kind: "settled";          provider; reference; receivedAmount?; settlement? }
| { kind: "failed";           provider; reference; error?; settlement? }
| { kind: "expired";          provider; reference; error?; settlement? }
| { kind: "ignore";           provider; reason }
```

## process

`process(c, environment, event)` is thin — ignore or apply:

```ts
async process(c: AppContext, _environment: SdpEnvironment, event: RampSettlementEvent) {
  if (event.kind === "ignore") return;
  await applyRampSettlementEvent(c, event);
}
```

Then register the class in `RAMP_PROVIDER_WEBHOOK_PROCESSOR` in `apps/sdp-api/src/routes/webhooks/handlers.ts`, or explicitly extend the excluded no-webhook provider union. `applyRampSettlementEvent` finds the transfer by `(provider, reference)`, skips terminal rows on redelivery, maps `kind → status`, persists received amounts for the relevant direction plus settlement economics, and records failed/expired errors.

## Beyond settlement (advanced)

BVNK also receives customer/wallet/provisioning events: its `parse` returns a wider `BvnkWebhookEvent` union, and `process` switches on `event.kind`, routing settlement kinds to `applyRampSettlementEvent`-based helpers and the rest to background provisioning helpers. That's an extension — the standard contract a new provider implements is the settlement path above.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- Verify the signature before trusting anything; never skip on a missing header — throw `UNAUTHORIZED`.
- No swallowed errors in your own logic; the orchestration owns the 2xx + background write.
- Event-type maps are `as const satisfies Record<string, RampSettlementEvent["kind"]>`; no `any` past the `verify` boundary.
- Verify focused webhook tests for valid, missing, malformed, stale, and replayed signatures; unknown events; duplicate terminal delivery; and settlement persistence. Run API typecheck/tests plus `@sdp/payments` checks when event types change.
