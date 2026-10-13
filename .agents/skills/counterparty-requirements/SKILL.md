---
name: counterparty-requirements
description: Implement a ramp provider's pure validateCounterparty decision in @sdp/payments plus the API-side requirements event flow — status events out, advance submissions in, provider state as counterparty_provider_accounts rows. PII is JIT pass-through only.
disable-model-invocation: true
---

# Counterparty requirements

Before a quote, the platform asks your provider what a counterparty still needs — KYC, a payout account, or nothing at all. `validateCounterparty` answers that. It is **pure and synchronous**: it reads the counterparty + handler-resolved state and returns a `CounterpartyRequirements`. No HTTP, no DB — the actual provisioning happens later, in the advance flow.

Use this skill for every provider, including providers that always return `ready`. The dashboard calls the requirements GET and POST flow before requesting a quote, so both schemas and an `advanceCounterpartyRequirements` branch must admit the provider even when there is no KYC or provisioning work to perform.

Canonical examples live in `packages/sdp-payments/src/ramps/providers/` — before writing yours, read the existing provider whose lifecycle is closest: inline ready decisions, collected-field KYC, customer-link → payout-tree provisioning, and hosted onboarding lifecycles are all represented.

## The event model

The requirements flow is a set of event streams, each a closed union discriminated on `(provider, status/kind)`. Adding a provider means declaring exactly which events it emits and accepts in each stream:

- **Status events out** (`GET /v1/counterparties/:counterpartyId/requirements`): `validateCounterparty` emits one arm of `CounterpartyRequirements` (`packages/sdp-types/src/ramp-requirements.ts`).
- **Advance submissions in** (`POST …/requirements`): one `submitCounterpartyRequirementsSchema` arm per provider (nested `discriminatedUnion("direction", …)` when payloads differ per direction). `collectedData` on the submission is the **only PII channel** in the platform.
- **Webhook auto-advance** (optional): providers with async provisioning also move requirement state from typed webhook events — see `integrate-webhook`.

## Provider state: `counterparty_provider_accounts`

All provider-side counterparty state is rows in this table — one row per provider resource. The row schema is `counterpartyProviderAccountRowSchema` in `apps/sdp-api/src/db/repositories/counterparty-provider-account.repository.ts`; every repo method is tenant-scoped and parent-scoped.

| Column | What it is and how to use it |
|---|---|
| `id` | `counterparty_provider_account_<uuid>`. Sent upstream as the platform-side account id on JIT creation where the provider accepts one, which makes creation idempotent (the provider rejects a duplicate id). |
| `organization_id`, `project_id`, `counterparty_id` | Tenant + parent scope. Every read and write takes all three — get/update/archive too, never just list. |
| `provider` | The ramp provider id; part of every lookup key. |
| `kind` | What the row represents: `customer_link` (the provider-side customer; one active per `(counterparty, provider)`, enforced by partial unique index), `payout_account` (off-ramp destination account), `funding_wallet` (on-ramp funding resource), `merchant_wallet` (merchant-owned provider wallet). Pick the kind that matches the resource; do not invent parallel storage. |
| `provider_customer_reference` | The provider's customer id the resource belongs to. Required on every row. |
| `external_account_reference` | The provider's own id for the resource (account/wallet id). `null` on `customer_link` rows. This is the value quote calls pass upstream. |
| `fiat_currency`, `destination_country`, `payment_rail` | The corridor. Set on corridor-scoped kinds; `null` where not applicable. There is no corridor uniqueness: several active rows can share one. |
| `provider_status` | The provider-reported lifecycle status, stored verbatim. Gate on it with a provider-side predicate before using the row in a quote; treat unknown values as not-ready. |
| `status` | SDP soft delete: `active` / `archived`. Replacement = archive + create a new row; never hard-delete, never update in place to repoint a resource. |
| `metadata` | Kind-discriminated JSON, schema-validated on write against the per-kind metadata schemas in the repository file. Provider references and state only — **never PII, never bank details**. |
| `created_at`, `updated_at` | Row timestamps; also the display timestamps when the provider reports none on the resource. |

**`counterparties.provider_data` is deprecated.** Do not add a provider key to it; new provider state must be a row here under the right `kind`. PII lands in neither place — it flows through advance-submission `collectedData`, JIT to the provider, and is discarded.

## Contract

```ts
validateCounterparty(counterparty: Counterparty, options: ValidateCounterpartyOptions): CounterpartyRequirements
```

`ValidateCounterpartyOptions` is direction-discriminated (`packages/sdp-payments/src/ramps/types.ts`): both arms carry `providerData` (legacy), `providerCustomerReference` (the handler-resolved `customer_link` reference), `cryptoToken?`, and `fiatCurrency?`; the offramp arm adds `cryptoRail?`. Trivial bodies (`readyCounterparty(...)`, or an `unsupported` guard) stay inline in the client; non-trivial decisions delegate to `providers/<id>/counterparty.ts`.

Status events every provider gets:

- `{ status: "ready" }` — good to quote.
- `{ status: "collect"; fields: RequirementField[] }` — need input first.
- `{ status: "unsupported"; reason }` — this counterparty/corridor can't be served, and why.

The full status union, discriminated on `(provider, status)`:

| Provider | Statuses |
|---|---|
| every provider | `ready`, `collect(fields)`, `unsupported(reason)` |
| bvnk | `onboarding_not_started`, `customer_verification_required(verificationUrl)`, `customer_verifying`, `customer_verification_failed`, `funding_account_provisioning`, `provisioning_failed` |

The authoritative union is `CounterpartyRequirements` in `packages/sdp-types/src/ramp-requirements.ts` — re-read it before editing; this table goes stale. Extend it only when generic `ready` / `collect` / `unsupported` cannot represent the provider.

`RequirementField` kinds (same module): `text`, `select`, `country`, `date`, and `address` (nested dotted-key parts). `country` is codes-only on the wire — the server never inlines a country option list; the client renders its own dropdown from `COUNTRIES` with flag labels; values are ISO 3166-1 alpha-2 both ways. Build fields with `textField`, `selectField`, `countryField`, `dateField`, and `readyCounterparty` from `packages/sdp-payments/src/ramps/requirements.ts`; don't hand-roll the shape.

## The decision (archetypes)

Simplest first — pick the closest and mirror its decision function:

- Always `readyCounterparty(...)` — no KYC gating.
- `collect` KYC fields, `ready` once the provider verifies the customer.
- Provider-hosted onboarding (ToS/verification URLs) advanced to `ready` by webhook events.

## The advance / submit flow

Both requirement routes must admit the provider before its client can run:

- `GET /v1/counterparties/:counterpartyId/requirements`: update the direction-specific provider lists in `apps/sdp-api/src/routes/counterparties/schemas.ts`.
- `POST /v1/counterparties/:counterpartyId/requirements`: add a provider arm to `submitCounterpartyRequirementsSchema` in `apps/sdp-api/src/routes/counterparties/schemas.ts`.

The POST handler re-runs `validateCounterparty`, validates submitted `collectedData`, then calls `advanceCounterpartyRequirements` in `apps/sdp-api/src/routes/payments/ramps/shared.ts`, which dispatches to the DB-side `ensure*` helper. The helper's job: provider HTTP with the collected PII, then persist the *result* as a `counterparty_provider_accounts` row.

**Hard rule: collected KYC is never persisted.** `collectedData` (SSN, IBAN, CDD, tax id) flows into the provider API call only. What lands in the account row is metadata — provider references, status, corridor, rail. Raw secrets are transient.

## Listing accounts

`GET /v1/counterparties/:id/provider-accounts` (own route module, `apps/sdp-api/src/routes/counterparty-provider-accounts/`) lists the rows as stored, adding each referenced BVNK funding wallet's live balance; nothing read live is written back. A retired provider's rows still list. The surface is provider-generic — never special-case a provider in the endpoint, response schema, or UI.

## Gating

Quotes consume the provisioned state: a verification-gated provider needs its active `customer_link` and any required resource rows (a BVNK off-ramp also needs its provisioned `funding_wallet`). If it's not there, the quote throws `counterpartyNotProvisioned` — it does not fall back to an ungated quote.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- `validateCounterparty` is pure — no HTTP, no DB; read only the counterparty + handler-resolved options.
- No fallbacks — `unsupported` with a reason beats a silent empty requirement; never persist collected KYC.
- Status + field types are discriminated unions — return exactly one arm; no `any`. No new `counterparties.provider_data` keys.
- Verify `@sdp/payments` typecheck/lint/tests plus focused API GET/POST requirement tests. Test the pure decision table and prove raw collected KYC is not persisted.
