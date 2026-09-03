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
| `fiat_currency`, `destination_country`, `payment_rail` | The corridor. Set on corridor-scoped kinds; `null` where not applicable. Multiple active rows per corridor — including per rail — are legal; there is no corridor uniqueness, so selection is explicit (`providerAccountId`), never assumed. |
| `provider_status` | The provider-reported lifecycle status, stored verbatim. Gate on it with a provider-side predicate before using the row in a quote; treat unknown values as not-ready. |
| `status` | SDP soft delete: `active` / `archived`. Replacement = archive + create a new row; never hard-delete, never update in place to repoint a resource. |
| `metadata` | Kind-discriminated JSON, schema-validated on write against the per-kind metadata schemas in the repository file. Provider references and state only — **never PII, never bank details**. |
| `created_at`, `updated_at` | Row timestamps; also the display timestamps when the provider reports none on the resource. |

**`counterparties.provider_data` is deprecated.** Do not add a provider key to it; new provider state must be a row here under the right `kind`. PII lands in neither place — it flows through advance-submission `collectedData`, JIT to the provider, and is discarded.

## Contract

```ts
validateCounterparty(counterparty: Counterparty, options: ValidateCounterpartyOptions): CounterpartyRequirements
```

`ValidateCounterpartyOptions` is direction-discriminated (`packages/sdp-payments/src/ramps/types.ts`): both arms carry `providerData` (legacy), `providerCustomerReference` (the handler-resolved `customer_link` reference), `cryptoToken?`, and `fiatCurrency?`; the offramp arm adds `cryptoRail?` and `payoutAccounts?` (handler-listed active corridor accounts). Trivial bodies (`readyCounterparty(...)`, or an `unsupported` guard) stay inline in the client; non-trivial decisions delegate to `providers/<id>/counterparty.ts`.

Status events every provider gets:

- `{ status: "ready"; providerAccountId? }` — good to quote. An offramp advance that resolved a payout account echoes its row id so the client can pass it back for explicit quote selection.
- `{ status: "collect"; fields: RequirementField[] }` — need input first.
- `{ status: "unsupported"; reason }` — this counterparty/corridor can't be served, and why.

The full status union, discriminated on `(provider, status)`:

| Provider | Statuses |
|---|---|
| every provider | `ready` (may carry `providerAccountId`), `collect(fields)`, `unsupported(reason)` |
| lightspark | `onboarding_not_started`, `collect_counterparty(fields)`, `collect_account(payout: PayoutRequirementTree)` |
| bvnk | `onboarding_not_started`, `customer_verification_required(verificationUrl)`, `customer_verifying`, `customer_verification_failed`, `funding_account_provisioning`, `provisioning_failed` |
| mural | `onboarding_not_started`, `terms_of_service_required(termsOfServiceUrl)`, `customer_verification_required(verificationUrl)`, `customer_verifying`, `customer_verification_failed`, `funding_account_provisioning` |

The authoritative union is `CounterpartyRequirements` in `packages/sdp-types/src/ramp-requirements.ts` — re-read it before editing; this table goes stale. Extend it only when generic `ready` / `collect` / `unsupported` cannot represent the provider.

`RequirementField` kinds (same module): `text`, `select`, `country`, `date`, and `address` (nested dotted-key parts). `country` is codes-only on the wire — the server never inlines a country option list; the client renders its own dropdown from `COUNTRIES` with flag labels; values are ISO 3166-1 alpha-2 both ways. Build fields with `textField`, `selectField`, `countryField`, `dateField`, and `readyCounterparty` from `packages/sdp-payments/src/ramps/requirements.ts`; don't hand-roll the shape.

## The payout tree (offramp account reuse)

`collect_account` carries a `PayoutRequirementTree` — destination-first collection:

- `countryRails`: destination country → rail options for the corridor.
- `railFields`: rail → fields with true per-rail requiredness.
- `accounts`: the counterparty's existing active accounts for the corridor, `{ id, destinationCountry, paymentRail, status, bankName?, accountNumberLast4? }`, so the client offers reuse instead of silently re-collecting bank fields.

Display info (`bankName`, `accountNumberLast4`) comes from JIT provider enrichment via the optional `listExternalAccountDetails` provider method — masked server-side, never persisted; absent fields stay absent (typed optional), never defaulted.

## The decision (archetypes)

Simplest first — pick the closest and mirror its decision function:

- Always `readyCounterparty(...)` — no KYC gating.
- `collect` KYC fields, `ready` once the provider verifies the customer.
- Customer link first (`collect_counterparty`), then per-corridor payout collection (`collect_account` with the payout tree; existing accounts offered for reuse), then `ready`.
- Provider-hosted onboarding (ToS/verification URLs) advanced to `ready` by webhook events.

## The advance / submit flow

Both requirement routes must admit the provider before its client can run:

- `GET /v1/counterparties/:counterpartyId/requirements`: update the direction-specific provider lists in `apps/sdp-api/src/routes/counterparties/schemas.ts`.
- `POST /v1/counterparties/:counterpartyId/requirements`: add a provider arm to `submitCounterpartyRequirementsSchema` in `apps/sdp-api/src/routes/payments/schemas.ts`. An offramp arm may also take `providerAccountId?` — an advance that selects an existing corridor account instead of collecting bank fields.

The POST handler re-runs `validateCounterparty`, validates submitted `collectedData`, then calls `advanceCounterpartyRequirements` in `apps/sdp-api/src/routes/payments/handlers/ramps.ts`, which dispatches to the DB-side `ensure*` helper. The helper's job: provider HTTP with the collected PII, then persist the *result* as a `counterparty_provider_accounts` row.

**Hard rule: collected KYC is never persisted.** `collectedData` (SSN, IBAN, CDD, tax id) flows into the provider API call only. What lands in the account row is metadata — provider references, status, corridor, rail. Raw secrets are transient.

## Listing accounts

`GET /v1/counterparties/:id/provider-accounts` (own route module, `apps/sdp-api/src/routes/counterparty-provider-accounts/`) lists the rows with JIT enrichment (`enrichCounterpartyProviderAccounts`): providers implementing `listExternalAccountDetails` contribute `bankName` / `accountNumberLast4` / `paymentRails` per request; nothing enriched is written back. The surface is provider-generic — never special-case a provider in the endpoint, response schema, or UI.

## Gating

Quotes consume the provisioned state: an offramp quote resolves the payout account explicitly (`providerAccountId`) or from the corridor's active rows; a verification-gated provider needs its active `customer_link` and any required resource rows. If it's not there, the quote throws `counterpartyNotProvisioned` — it does not fall back to an ungated quote.

## Rules + verify

Shared rules live in `integrate-ramp-provider`. Hot here:

- `validateCounterparty` is pure — no HTTP, no DB; read only the counterparty + handler-resolved options.
- No fallbacks — `unsupported` with a reason beats a silent empty requirement; never persist collected KYC.
- Status + field types are discriminated unions — return exactly one arm; no `any`. No new `counterparties.provider_data` keys.
- Verify `@sdp/payments` typecheck/lint/tests plus focused API GET/POST requirement tests. Test the pure decision table and prove raw collected KYC is not persisted.
