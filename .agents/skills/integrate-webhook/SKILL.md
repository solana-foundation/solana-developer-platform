---
name: integrate-webhook
description: Implement a ramp provider's webhook — validateWebhook (signature verification) plus parseSettlementEvent (→ RampSettlementEvent) — and a thin route handler that calls applyRampSettlementEvent to advance the transfer. Use when opening a PR against apps/sdp-api to add webhook/settlement handling for a ramp provider.
---

# Integrate webhook

Webhooks drive a transfer's lifecycle after the quote: `awaiting_payment → settling → completed | failed | expired`. You implement two provider methods and add one thin handler file:

- `validateWebhook(ctx)` — verify the signature, return `{ provider, payload }`.
- `parseSettlementEvent(payload)` — map the upstream event to a `RampSettlementEvent`.

Canonical example: `validateWebhook` + `parseSettlementEvent` in `lib/ramps/providers/lightspark.ts`, and the handler `routes/webhooks/ramps/lightspark.ts`.

## Mount + flow

Webhooks are **not** under `/v1`. They land at `POST /webhooks/payments/ramps/{sandbox|production}/:provider` (`routes/webhooks/index.ts`). `parseRampWebhookProvider` accepts your id automatically once it's in `RAMP_PROVIDER_CLIENTS`. `handleRampProviderWebhook` (`routes/webhooks/handlers.ts`) then reads the raw body → `validateWebhook` → dispatches to your `handle<Id>RampWebhook` → returns 2xx. The DB write runs in the background (`c.executionCtx.waitUntil`) so the ack isn't delayed.

## validateWebhook

`ctx: RampWebhookValidationContext` = `{ env, environment, headers, rawBody, requestUrl? }` → `Promise<{ provider, payload: unknown }>`. Read the mode-keyed verification secret/key from `env`, verify the signature over the **raw** body, then `JSON.parse`. Throw `UNAUTHORIZED` on a missing/invalid signature; throw `badRequest` on non-JSON. Verify with the shared `verifyWebhookSignature` (`lib/webhook-signature.ts`) — pass it a discriminated `algorithm`: `hmac-sha256` (with `hex` or `base64` encoding) or `ecdsa-sha256` (with a PEM public key). It handles the constant-time comparison.

This is one of the few places `unknown` is allowed — it's a genuine trust boundary, narrowed immediately by `parseSettlementEvent`.

Signature variety across the three providers:

| Provider | Header | Algorithm | Env keys |
|---|---|---|---|
| Lightspark | `x-grid-signature` | ECDSA P-256 / SHA-256 (public key) | `LIGHTSPARK_GRID_WEBHOOK_PUBLIC_KEY` / `…_SANDBOX_…` |
| MoonPay | `moonpay-signature-v2` | HMAC-SHA256 (hex, `t=…,s=…`) | `MOONPAY_WEBHOOK_KEY` / `MOONPAY_SANDBOX_WEBHOOK_KEY` |
| BVNK | `x-signature` | HMAC-SHA256 (base64) | `BVNK_WEBHOOK_SECRET` / `BVNK_SANDBOX_WEBHOOK_SECRET` |

## parseSettlementEvent

`(payload: unknown) → RampSettlementEvent`. Narrow the payload with typed parse helpers, map the upstream event type to a `kind` via an `as const satisfies Record<string, RampSettlementEvent["kind"]>` table, and set `reference` to the id you returned from the quote — that's how `applyRampSettlementEvent` finds the transfer. Anything you don't handle → `{ provider, kind: "ignore", reason }`.

`RampSettlementEvent` (`lib/ramps/types.ts`):

```
| { kind: "awaiting_payment"; provider; reference }
| { kind: "settling";         provider; reference }
| { kind: "settled";          provider; reference; receivedAmount?; settlement? }
| { kind: "failed";           provider; reference; error?; settlement? }
| { kind: "expired";          provider; reference; error?; settlement? }
| { kind: "ignore";           provider; reason }
```

## The handler file

`routes/webhooks/ramps/<id>.ts` is thin — parse, ignore, or apply:

```ts
export async function handle<Id>RampWebhook(c: AppContext, payload: unknown) {
  const event = RAMP_PROVIDER_CLIENTS.<id>.parseSettlementEvent(payload);
  if (event.kind === "ignore") return;
  await applyRampSettlementEvent(c, event);
}
```

Then add a `case "<id>"` to the dispatch switch in `routes/webhooks/handlers.ts` (it ends in `satisfies never`). `applyRampSettlementEvent` (`routes/webhooks/ramps/settlements.ts`) finds the transfer by `(provider, reference)`, is idempotent (skips terminal statuses — redelivered events never regress), maps `kind → status`, writes the received fiat amount on a settled off-ramp, and the error on failed/expired.

## Beyond settlement (advanced)

BVNK also receives customer/wallet/provisioning events and routes them separately (`parseBvnkWebhookEvent`, background provisioning). That's an extension — the standard contract a new provider implements is the settlement path above.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- Verify the signature before trusting anything; never skip on a missing header — throw `UNAUTHORIZED`.
- No swallowed errors in your own logic; the orchestration owns the 2xx + background write.
- Event-type maps are `as const satisfies Record<string, RampSettlementEvent["kind"]>`; no `any` past the `validateWebhook` boundary.
- Verify with `tsc --noEmit` + `biome check`; unit-test signature + parsing like `providers/lightspark.test.ts`.
