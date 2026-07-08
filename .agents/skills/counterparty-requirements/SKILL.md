---
name: counterparty-requirements
description: Implement a ramp provider's validateCounterparty → CounterpartyRequirements — a pure, synchronous decision over stored provider_data — plus the JIT collected-field advance flow. Use when opening a PR against apps/sdp-api to add counterparty/KYC requirements for a ramp provider.
---

# Counterparty requirements

Before a quote, the platform asks your provider what a counterparty still needs — KYC, a payout account, or nothing at all. `validateCounterparty` answers that. It is **pure and synchronous**: it reads the counterparty + its `provider_data` and returns a `CounterpartyRequirements`. No HTTP, no DB — the actual provisioning happens later, in the advance flow.

Canonical examples: `lib/ramps/providers/lightspark/counterparty.ts` and `providers/bvnk/counterparty.ts` (MoonPay just returns ready, inline in `providers/moonpay/client.ts`).

## Contract

```ts
validateCounterparty(counterparty: Counterparty, options: ValidateCounterpartyOptions): CounterpartyRequirements
```

`options` = `{ direction: RampDirection, providerData: CounterpartyProviderData, fiatCurrency? }`. Trivial bodies (`readyCounterparty(...)`, or an `unsupported` guard) stay inline in `providers/<id>/client.ts`; non-trivial decisions delegate to `providers/<id>/counterparty.ts`.

`CounterpartyRequirements` is discriminated by `provider`; the `status` union (`packages/sdp-types/src/ramp-requirements.ts`):

- `{ status: "ready" }` — good to quote.
- `{ status: "collect"; fields: RequirementField[] }` — need input first.
- `{ status: "unsupported"; reason }` — this counterparty/corridor can't be served, and why.
- onboarding states (Lightspark/BVNK): `onboarding_not_started`, `customer_verification_required` (+`verificationUrl`), `customer_verifying`, `customer_verification_failed`, `funding_account_provisioning`, `provisioning_failed`.

`RequirementField` is a discriminated union (same module):

- `{ kind: "text"; key; label; required; pattern?; minLength?; maxLength?; placeholder?; mask? }`
- `{ kind: "select"; key; label; required; options: { value; label }[] }`

Build fields with the existing helpers in `lib/ramps/requirements.ts` (`textField`, `selectField`, `readyCounterparty`); don't hand-roll the shape.

## The decision (variety)

| Provider | validateCounterparty |
|---|---|
| MoonPay | always `readyCounterparty(...)` — no KYC gating |
| Lightspark | on-ramp ready; off-ramp `ready` if an active payout account exists, else `collect` payout fields (per-currency spec), else `unsupported` |
| BVNK | off-ramp ready; on-ramp `ready` if a verified customer exists, else `collect` KYC fields, else `unsupported` (business entity / missing country) |

## The advance / submit flow

`POST /v1/counterparties/:counterpartyId/requirements` (`submitCounterpartyRequirementsSchema`, a `discriminatedUnion("provider", …)`). The handler re-runs `validateCounterparty`, validates the submitted `collectedData` against your fields (`buildRequirementSchema`), then calls `advanceCounterpartyRequirements` (`routes/payments/handlers/ramps.ts`), which dispatches to your DB-side `ensure*` helper (e.g. `ensureLightsparkPayoutAccount`, `ensureBvnkCustomer`).

**Hard rule: collected KYC is never persisted.** `collectedData` (SSN, IBAN, CDD, tax id) flows into the provider API call only. What lands in `provider_data` is metadata — customer id, account id, status, timestamps. Raw secrets are transient. (`GET /v1/counterparties/:id/requirements` exposes the current requirements for the client wizard.)

## Gating

Quotes consume the provisioned state: a Lightspark quote needs `customerId` + an active payout account; a BVNK quote needs a verified customer + ready rule. If it's not there, the quote throws `counterpartyNotProvisioned` — it does not fall back to an ungated quote.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- `validateCounterparty` is pure — no HTTP, no DB; read only `counterparty` + `providerData`.
- No fallbacks — `unsupported` with a reason beats a silent empty requirement; never persist collected KYC.
- Status + field types are discriminated unions — return exactly one arm; no `any`.
- Verify with `tsc --noEmit` + `biome check`; test the decision table like `providers/lightspark/counterparty.test.ts`.
