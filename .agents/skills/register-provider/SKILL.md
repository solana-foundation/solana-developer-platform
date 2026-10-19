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

`RampProvider` currently requires both estimates, rail discovery/distillation, counterparty validation, and an off-ramp method. An unsupported direction must use empty declared/discovered support plus a typed unsupported requirement or payments error; it must not pretend to work. `createOnrampQuote` is optional. `fetchTransferStatus` is optional on the contract but required in practice: the status sweep's `RAMP_STATUS_PULLS` table fails typecheck without it. It makes one request per lookup and returns the events the provider's webhook would carry, oldest first, through the package status mapping the webhook parser also calls; an empty answer must mean the provider holds no transaction, never that SDP could not ask.

Use one mode-aware config reader over the passed `env`. Provider code performs HTTP only and imports neither `AppContext` nor database modules. Use `providerFetchJson` for provider requests, with a zod schema of exactly the response fields the adapter reads (a mismatch fails closed as `PROVIDER_RESPONSE_INVALID`, 502), and payments-package errors such as `providerNotConfigured`, `providerUnavailable`, and `estimateNotAvailable`. An error's message and `details` are returned to callers, so they carry only SDP's own wording; the provider's message, codes and field errors go in its `diagnostics` (ADR 0008), which the API logs and never returns. Add `providers/<id>/test-kit.ts` (recorded exchanges per direction, `transferStatus` lookups including the provider's answer for a transfer it holds nothing for, the mode-credential check, one malformed reply) and register it in `KITS` in `packages/sdp-payments/src/ramps/contract.test.ts`; typecheck fails until you do, and the suite pins one request per status lookup.

If API-side handlers import provider-specific public helpers or types through package subpaths, add explicit exports in `packages/sdp-payments/package.json`.

## 3. Wire API admission and orchestration

Update every applicable site:

| Site | Decision |
|---|---|
| `apps/sdp-api/src/services/provider-availability.service.ts` | label plus prod/sandbox credential completeness; `testMode === undefined` means either configured mode |
| `apps/sdp-api/src/services/provider-setup-registry.ts` | add `rampSetup("<id>")`; ramps are deployment-managed today |
| `apps/sdp-api/src/routes/counterparties/schemas.ts` | add the provider-specific submit-requirements schema arm; add the id only to the directions actually supported |
| `apps/sdp-api/src/routes/payments/ramps/{onramp,offramp}/handlers.ts` + `ramps/shared.ts` | add quote branches per direction and `advanceCounterpartyRequirements` branches in `shared.ts` for every provider; unsupported directions reject explicitly; keep DB work here or in `ramps/providers/<id>.ts` |
| `apps/sdp-api/src/services/ramps/webhooks/registry.ts` | register the provider's `WebhookProcessor`; the registry covers every provider id, so typecheck fails until you do |
| `apps/sdp-api/src/services/jobs/sweep-ramp-transfer-statuses.ts` | add the provider to `RAMP_STATUS_PULLS` (its client paired with its processor) and `RAMP_ABANDONMENT_HORIZON_MS` (how long a quiet checkout stays open per direction: a product call, recorded with its reason) |

Availability is tri-state by environment:

```ts
isConfigured: (env, testMode) => {
  const prod = hasAllEnv(env, ["<PROVIDER>_KEY", "<PROVIDER>_SECRET"]);
  const sandbox = hasAllEnv(env, ["<PROVIDER>_SANDBOX_KEY", "<PROVIDER>_SANDBOX_SECRET"]);
  if (testMode === true) return sandbox;
  if (testMode === false) return prod;
  return prod || sandbox;
},
```

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

Add every runtime key to all environment-contract projections that consume API keys:

1. `apps/sdp-api/src/types/env.d.ts`
2. `turbo.json` `globalEnv`
3. `scripts/secret-keys.mjs` `API_LOCAL_ENV_KEYS`
4. `apps/sdp-api/.env.local.example` with commented placeholders and no real credentials

If the provider has distinct webhook keys, API base URL overrides, account ids, or sandbox-only settings, include those exact keys too. A missing required key must produce `PROVIDER_NOT_CONFIGURED` (503).

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
