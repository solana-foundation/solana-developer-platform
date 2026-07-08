---
name: integrate-webhook
description: Implement a ramp provider's webhook as a WebhookProcessor — verify (signature verification), parse (→ RampSettlementEvent), and process (DB orchestration via applyRampSettlementEvent) — registered in the webhook dispatch map. Use when opening a PR against apps/sdp-api to add webhook/settlement handling for a ramp provider.
---

# Integrate webhook

Webhooks drive a transfer's lifecycle after the quote: `awaiting_payment → settling → completed | failed | expired`. You implement one class — a `WebhookProcessor` (`routes/webhooks/ramps/processor.ts`) — with three methods, all living in a single route file:

- `verify(context)` — verify the signature, return the parsed payload.
- `parse(payload)` — pure wire-format → `RampSettlementEvent` mapping.
- `process(c, environment, event)` — DB orchestration; calls `applyRampSettlementEvent`.

Canonical example: `LightsparkWebhookProcessor` in `routes/webhooks/ramps/lightspark.ts`.

## Mount + flow

Webhooks are **not** under `/v1`. They land at `POST /webhooks/payments/ramps/{sandbox|production}/:provider` (`routes/webhooks/index.ts`). `parseRampWebhookProvider` accepts your id automatically once it's registered in the `RAMP_PROVIDER_WEBHOOK_PROCESSOR` map (`routes/webhooks/handlers.ts`). `handleRampProviderWebhook` then reads the raw body → `processor.verify()` → `processor.parse()` → returns 2xx immediately, then runs `processor.process()` in the background (`c.executionCtx.waitUntil`) so the ack isn't delayed.

## verify

`verify(context: RampWebhookValidationContext): Promise<Payload>`. `context` = `{ env, environment, headers, rawBody, requestUrl? }`. Read the mode-keyed verification secret/key from `env`, verify the signature over the **raw** body, then `JSON.parse` and return the payload. Throw `UNAUTHORIZED` on a missing/invalid signature; throw `badRequest` on non-JSON. Verify with the shared `verifyWebhookSignature` (`lib/webhook-signature.ts`) — pass it a discriminated `algorithm`: `hmac-sha256` (with `hex` or `base64` encoding) or `ecdsa-sha256` (with a PEM public key). It handles the constant-time comparison.

This is one of the few places `unknown` is allowed — it's a genuine trust boundary, narrowed immediately by `parse`.

Signature variety across the four providers with webhooks:

| Provider | Header | Algorithm | Env keys |
|---|---|---|---|
| Lightspark | `x-grid-signature` | ECDSA P-256 / SHA-256 (public key) | `LIGHTSPARK_GRID_WEBHOOK_PUBLIC_KEY` / `…_SANDBOX_…` |
| MoonPay | `moonpay-signature-v2` | HMAC-SHA256 (hex, `t=…,s=…`) | `MOONPAY_WEBHOOK_KEY` / `MOONPAY_SANDBOX_WEBHOOK_KEY` |
| BVNK | `x-signature` | HMAC-SHA256 (base64) | `BVNK_WEBHOOK_SECRET` / `BVNK_SANDBOX_WEBHOOK_SECRET` |
| Coinbase | `x-hook0-signature` | HMAC-SHA256 (hex, `t=…,v0=…`) | `COINBASE_CDP_RAMPS_WEBHOOK_SECRET` |

## parse

`(payload: Payload) → Event`, typically a `RampSettlementEvent`. Narrow the payload with `readString` / `readRecord` / `readNumber` from `@/lib/json` — never hand-rolled readers or a cast. Map the upstream event type to a `kind` via an `as const satisfies Record<string, RampSettlementEvent["kind"]>` table, and set `reference` to the id you returned from the quote — that's how `applyRampSettlementEvent` finds the transfer. Anything you don't handle → `{ provider, kind: "ignore", reason }`.

`parse` runs synchronously **before** the 2xx ack, so it must be total over every payload the provider can legitimately sign: unknown event types and transactions the platform didn't create (sandbox tests, manual payments on the same account) must map to an `ignore` event or an absent reference — never a throw, which turns into a non-2xx and a provider retry loop. Reserve throws for payloads that violate the provider's own guaranteed envelope (e.g. a missing event type), where a loud deterministic failure is the point. Example: BVNK channel references not minted by SDP return `undefined` from `readBvnkOfframpReference` and get logged-and-skipped in `process`.

`RampSettlementEvent` (`lib/ramps/types.ts`):

```
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

Then register the class in `RAMP_PROVIDER_WEBHOOK_PROCESSOR` in `routes/webhooks/handlers.ts` (it's `as const satisfies Record<Exclude<RampProviderId, "moneygram">, WebhookProcessor<...>>` — add your `<id>: new <Id>WebhookProcessor()`, or extend the `Exclude` list if your provider doesn't use webhooks). `applyRampSettlementEvent` (`routes/webhooks/ramps/settlements.ts`) finds the transfer by `(provider, reference)`, is idempotent (skips terminal statuses — redelivered events never regress), maps `kind → status`, writes the received fiat amount on a settled off-ramp, and the error on failed/expired.

## Beyond settlement (advanced)

BVNK also receives customer/wallet/provisioning events: its `parse` returns a wider `BvnkWebhookEvent` union, and `process` switches on `event.kind`, routing settlement kinds to `applyRampSettlementEvent`-based helpers and the rest to background provisioning helpers. That's an extension — the standard contract a new provider implements is the settlement path above.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- Verify the signature before trusting anything; never skip on a missing header — throw `UNAUTHORIZED`.
- No swallowed errors in your own logic; the orchestration owns the 2xx + background write.
- Event-type maps are `as const satisfies Record<string, RampSettlementEvent["kind"]>`; no `any` past the `verify` boundary.
- Verify with `tsc --noEmit` + `biome check`; unit-test `parse` like `routes/webhooks/ramps/bvnk.test.ts`.
