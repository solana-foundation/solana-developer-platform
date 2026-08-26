---
name: counterparty-requirements
description: Implement a ramp provider's pure validateCounterparty decision in @sdp/payments plus the API-side collected-field advance flow, schemas, and provider-data persistence.
disable-model-invocation: true
---

# Counterparty requirements

Before a quote, the platform asks your provider what a counterparty still needs — KYC, a payout account, or nothing at all. `validateCounterparty` answers that. It is **pure and synchronous**: it reads the counterparty + its `provider_data` and returns a `CounterpartyRequirements`. No HTTP, no DB — the actual provisioning happens later, in the advance flow.

Use this skill for every provider, including providers that always return `ready`. The dashboard calls the requirements GET and POST flow before requesting a quote, so both schemas and an `advanceCounterpartyRequirements` branch must admit the provider even when there is no KYC or provisioning work to perform.

Canonical examples live in `packages/sdp-payments/src/ramps/providers/`: Lightspark and BVNK for collected fields, Mural for hosted onboarding states, and MoonPay for an inline ready decision.

## Contract

```ts
validateCounterparty(counterparty: Counterparty, options: ValidateCounterpartyOptions): CounterpartyRequirements
```

`options` = `{ direction, providerData, cryptoToken?, fiatCurrency?, destinationWalletAddress? }`. Trivial bodies (`readyCounterparty(...)`, or an `unsupported` guard) stay inline in the client; non-trivial decisions delegate to `providers/<id>/counterparty.ts`.

`CounterpartyRequirements` is discriminated by `provider`; the `status` union (`packages/sdp-types/src/ramp-requirements.ts`). Every provider gets these three:

- `{ status: "ready" }` — good to quote.
- `{ status: "collect"; fields: RequirementField[] }` — need input first.
- `{ status: "unsupported"; reason }` — this counterparty/corridor can't be served, and why.
- provider-specific onboarding states currently cover Lightspark, BVNK, and Mural, including verification URLs, terms-of-service URLs, verification progress/failure, and funding-account provisioning. Read the authoritative union in `packages/sdp-types/src/ramp-requirements.ts`; extend it only when generic `ready` / `collect` / `unsupported` cannot represent the provider.

`RequirementField` is a discriminated union (same module):

- `{ kind: "text"; key; label; required; pattern?; minLength?; maxLength?; placeholder?; mask? }`
- `{ kind: "select"; key; label; required; options: { value; label }[] }`

Build fields with `textField`, `selectField`, and `readyCounterparty` from `packages/sdp-payments/src/ramps/requirements.ts`; don't hand-roll the shape.

## The decision (variety)

| Provider | validateCounterparty |
|---|---|
| MoonPay | always `readyCounterparty(...)` — no KYC gating |
| Lightspark | on-ramp ready; off-ramp `ready` if an active payout account exists, else `collect` payout fields (per-currency spec), else `unsupported` |
| BVNK | off-ramp ready; on-ramp `ready` if a verified customer exists, else `collect` KYC fields, else `unsupported` (business entity / missing country) |
| Mural | provider-hosted organization/KYC/ToS lifecycle with account provisioning |

## The advance / submit flow

Both requirement routes must admit the provider before its client can run:

- `GET /v1/counterparties/:counterpartyId/requirements`: update the direction-specific provider lists in `apps/sdp-api/src/routes/counterparties/schemas.ts`.
- `POST /v1/counterparties/:counterpartyId/requirements`: add a provider arm to `submitCounterpartyRequirementsSchema` in `apps/sdp-api/src/routes/payments/schemas.ts`.

The POST handler re-runs `validateCounterparty`, validates submitted `collectedData`, then calls `advanceCounterpartyRequirements` in `apps/sdp-api/src/routes/payments/handlers/ramps.ts`, which dispatches to the DB-side `ensure*` helper.

**Hard rule: collected KYC is never persisted.** `collectedData` (SSN, IBAN, CDD, tax id) flows into the provider API call only. What lands in `provider_data` is metadata — customer id, account id, status, timestamps. Raw secrets are transient. (`GET /v1/counterparties/:id/requirements` exposes the current requirements for the client wizard.)

## Gating

Quotes consume the provisioned state: a Lightspark quote needs `customerId` + an active payout account; a BVNK quote needs a verified customer + ready rule. If it's not there, the quote throws `counterpartyNotProvisioned` — it does not fall back to an ungated quote.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- `validateCounterparty` is pure — no HTTP, no DB; read only `counterparty` + `providerData`.
- No fallbacks — `unsupported` with a reason beats a silent empty requirement; never persist collected KYC.
- Status + field types are discriminated unions — return exactly one arm; no `any`.
- Verify `@sdp/payments` typecheck/lint/tests plus focused API GET/POST requirement tests. Test the pure decision table and prove raw collected KYC is not persisted.
