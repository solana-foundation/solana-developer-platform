---
name: register-provider
description: Register a new ramp provider across the SDP payments package, API schemas and dispatch, availability/setup, environment contract, shared quote types, webhooks, and dashboard catalog. Step 1 for a provider-owned ramp integration PR.
disable-model-invocation: true
---

# Register a ramp provider

Build the smallest honest skeleton for the capabilities the provider supports. Registration spans three ownership boundaries:

- `packages/sdp-payments`: HTTP adapter and normalized ramp contract.
- `apps/sdp-api`: auth, request gates, DB orchestration, provider availability, schemas, and webhooks.
- `packages/sdp-types` / `apps/sdp-web`: shared public shapes and provider presentation.

## 1. Add the closed provider id

Add the lowercase id to `RAMP_PROVIDERS` in `packages/sdp-types/src/provider-access.ts`. `GENERAL_PROVIDER_DEFAULTS.ramps` currently enables every registered ramp for every organization; availability still fails closed when deployment credentials are absent. Registration is therefore a launch decision, not a hidden stub. Do not add the id until the implemented capability is safe to surface.

Run these immediately and follow every exhaustive error:

```bash
pnpm --filter @sdp/payments typecheck
pnpm --filter @sdp/api typecheck
pnpm --filter sdp-web typecheck
```

The compiler is only part of the checklist; Zod unions, translations, and ordered UI lists may not fail automatically.

## 2. Add the package adapter

Create `packages/sdp-payments/src/ramps/providers/<id>/client.ts` and export/register it in `packages/sdp-payments/src/ramps/index.ts`:

```ts
export class <Id>RampClient implements RampProvider {
  readonly id = "<id>";
  readonly declaredRailSupport = <ID>_DECLARED_RAIL_SUPPORT;
  // Implement the methods required by packages/sdp-payments/src/ramps/types.ts.
}
```

`RampProvider`'s members are function-typed, so an implementation is checked strictly. Every provider has an `id`, a `label` (its name in SDP's messages), declared rail support, `keyFormats`, rail discovery/distillation, counterparty validation and `fetchTransferStatus`. A direction the provider runs has both of its members (`estimateOnramp` + `createOnrampQuote`, `estimateOfframp` + `createOfframpQuote`); a direction it doesn't run has neither, plus empty declared/discovered support and a typed unsupported requirement. `supportsRampDirection` and `rampClientFor` read member presence, and the contract suite fails a provider with half a direction. `cancelOfframpSale` is optional. `fetchTransferStatus` makes one request per lookup and returns the events the provider's webhook would carry, oldest first, through the package status mapping the webhook parser also calls; an empty answer must mean the provider holds no transaction, never that SDP could not ask.

Every call gets a `RampRuntimeContext` of `{ mode, cluster, credentials }` (the account's `publicKey` and `secretKey`); the API resolves it, so provider code never sees the process env. Read the keys with `rampCredentials(this, ctx)` from `#/ramps/shared`: it checks them against `keyFormats[ctx.mode]` first, so a key from the other mode never makes a request. `keyFormats` is an `<ID>_KEY_FORMATS` table that `satisfies RampKeyFormats`: both modes, the same keys, a `webhookSecret` unless the provider only polls, each format strict enough to refuse the other mode's key and an unsynced `placeholder` mount. Its keys are the managed keys SDP holds (`docs/contributing/ramp-provider-safety.md`, "Managed keys"). Hosts follow `ctx.mode` inside the adapter. Provider code performs HTTP only and imports neither `AppContext` nor database modules. Use `providerFetchJson` for provider requests, with a zod schema of exactly the response fields the adapter reads (a mismatch fails closed as `PROVIDER_RESPONSE_INVALID`, 502), and payments-package errors such as `providerNotConfigured`, `providerUnavailable`, and `estimateNotAvailable`. An error's message and `details` are returned to callers, so they carry only SDP's own wording; the provider's message, codes and field errors go in its `diagnostics` (ADR 0008), which the API logs and never returns. Add `providers/<id>/test-kit.ts` (test-mode `credentials` and `liveCredentials`, `webhookSecrets` by mode unless it only polls, recorded exchanges per direction, `transferStatus` lookups including the provider's answer for a transfer it holds nothing for, the credential checks on requests and quotes, one malformed reply) and register it in `KITS` in `packages/sdp-payments/src/ramps/contract.test.ts`; typecheck fails until you do, and the suite pins one request per status lookup and refuses each mode's calls on the other mode's keys.

Register the client in `RAMP_PROVIDER_CLIENTS` and its status-pull event type in `RampProviderSettlementEvents` (`packages/sdp-payments/src/ramps/index.ts`). Callers reach it only through the contract. Outside the package, only the provider's webhook processor imports its modules, and only its status mapping (export it as `./ramps/providers/<id>/<x>-status-mapping`); `packages/sdp-payments/src/ramps/boundaries.test.ts` enforces it.

## 3. Wire API admission and orchestration

Update every applicable site:

| Site | Decision |
|---|---|
| `apps/sdp-api/src/services/ramps/runtime.ts` | add the provider's own term for its public key to `PUBLIC_KEY_TERMS` (typecheck fails until you do); the names follow from it and `keyFormats`, and every runtime, availability check, discovery run and webhook verification resolves keys here |
| `apps/sdp-api/src/services/provider-availability.service.ts` | `managedRampDefinition("<id>")`: configured only while every key it declares fits the project's mode |
| `apps/sdp-api/src/services/provider-setup-registry.ts` | add `rampSetup("<id>")`; ramps are deployment-managed today |
| `apps/sdp-api/src/routes/counterparties/schemas.ts` | add the provider-specific submit-requirements schema arm; add the id only to the directions actually supported |
| `apps/sdp-api/src/routes/payments/ramps/{onramp,offramp}/handlers.ts` + `ramps/shared.ts` | add the quote case per direction, calling `rampClientFor("<id>", direction)` with `rampRuntime(c, "<id>")`, and `advanceCounterpartyRequirements` branches in `shared.ts`; unsupported directions reject explicitly; keep DB work here or in `ramps/providers/<id>.ts` |
| `apps/sdp-api/src/services/ramps/webhooks/registry.ts` | register the provider's `WebhookProcessor`; the registry covers every provider id, so typecheck fails until you do |
| `apps/sdp-api/src/services/jobs/sweep-ramp-transfer-statuses.ts` | add the provider to `RAMP_STATUS_PULLS` (its client paired with its processor) and `RAMP_ABANDONMENT_HORIZON_MS` (how long a quiet checkout stays open per direction: a product call, recorded with its reason) |

Live keys sit only in Doppler `prd`, so a production project elsewhere answers `PROVIDER_NOT_CONFIGURED`. Per-project accounts (HOO-1942, HOO-1943) will override the managed keys.

Do not add obsolete `executeOnramp` / `executeOfframp` branches; those methods are not part of the current provider contract.

Provider-side counterparty state is `counterparty_provider_accounts` rows discriminated by `kind` (`customer_link`, `payout_account`, `funding_wallet`, `merchant_wallet`). **Never add a key to `counterparties.provider_data`** — it is deprecated; PII arrives only through requirements-advance `collectedData` and is passed JIT to the provider, never persisted.

## 4. Extend shared contracts

Add the provider to a closed `PaymentRampQuote` arm in `packages/sdp-types/src/payments.ts`, even when an existing delivery-mode shape fits; for example, extend the provider literal on the hosted arm. Add a `PaymentRampInstruction` arm for a new manual instruction shape. The supported delivery modes are:

- `manual_instructions`: bank or crypto funding instructions.
- `hosted`: a provider-hosted URL.
- `session_widget`: an embedded provider session.

Add provider-specific onboarding states to `packages/sdp-types/src/ramp-requirements.ts` only when the existing generic states cannot represent the upstream lifecycle. Extend `RampTransferSettlement` when signed settlement events carry provider-specific economics worth preserving. Update `apps/sdp-api/src/openapi/**` when the public request or response contract changes, then run the owning generators from `AGENTS.md`.

```bash
pnpm -C apps/sdp-api openapi:generate
pnpm generate:api-playground
pnpm -C apps/sdp-docs generate:api
pnpm -C apps/sdp-docs generate:ai
```

## 5. Declare environment keys

Add the provider's managed key names (`<PROVIDER>_<MODE>_<ROLE>`, both modes) and any other runtime key to all environment-contract projections that consume API keys. `provider-availability.drift.test.ts` fails until the first four list exactly `MANAGED_RAMP_KEY_NAMES`:

1. `apps/sdp-api/src/types/env.d.ts`
2. `turbo.json` `globalEnv`
3. `scripts/secret-keys.mjs` `API_LOCAL_ENV_KEYS`
4. `apps/sdp-api/.env.local.example` with commented placeholders and no real credentials

Hosts are not env keys: they follow `ctx.mode` inside the adapter. A missing key, or one from the other mode, produces `PROVIDER_NOT_CONFIGURED` (503). Doppler and sdp-infra follow the checklist in `docs/contributing/ramp-provider-safety.md`, "Managed keys".

## 6. Surface the provider in the dashboard

At minimum update:

- `apps/sdp-web/src/lib/ramps.ts`: logo and ordered label option.
- `apps/sdp-web/src/app/dashboard/integrations/integrations-status.ts`: label and description key.
- `apps/sdp-web/messages/*/shared.json`: provider description in every locale.
- `apps/sdp-web/public/provider-logos/`: provider asset.

If the provider introduces a new onboarding lifecycle, manual instruction shape, or session-widget fields, update the provider helpers and quote renderer under `apps/sdp-web/src/app/dashboard/payments/ramps/`. Reuse an existing delivery-mode renderer only when its contract already fits.

## 7. Document setup and limits

Update `apps/sdp-docs/content/docs/payments/ramps-providers.mdx` with supported directions, rails, entity/country limits, sandbox behavior, required environment keys, webhook setup, and known limitations. Keep public endpoint claims aligned with `apps/sdp-api/src/openapi/**`, then run:

```bash
pnpm --filter sdp-docs check:links
pnpm --filter sdp-docs build
```

## Verify

Add mocked provider-client tests and focused API tests for supported directions, unsupported directions, malformed responses, missing credentials, counterparty gating, webhook verification, and status lookups (a known transaction, nothing held, a provider error). Then run:

```bash
pnpm --filter @sdp/payments typecheck
pnpm --filter @sdp/payments lint
pnpm --filter @sdp/payments test
pnpm --filter @sdp/api typecheck
pnpm --filter @sdp/api test -- <focused-test-files>
pnpm --filter sdp-web typecheck
pnpm --filter sdp-web check:i18n
pnpm check:module-boundaries
```

Continue with `rail-discovery`, `integrate-estimate`, `counterparty-requirements` for every provider, the needed quote direction skill, and `integrate-webhook` for settlement and the status pull.
