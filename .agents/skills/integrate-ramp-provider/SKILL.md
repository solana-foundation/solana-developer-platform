---
name: integrate-ramp-provider
description: Start here for a provider-owned fiat↔crypto ramp integration PR spanning @sdp/payments, shared contracts, sdp-api orchestration, webhooks, and dashboard presentation.
disable-model-invocation: true
---

# Integrate a ramp provider

Use this router for a provider-owned integration PR. Keep the reusable provider adapter in `packages/sdp-payments`, shared public types in `packages/sdp-types`, and API/webhook/DB orchestration in `apps/sdp-api`.

## Inputs

- **`docs`** — provider API documentation URL; use it as the source of truth for auth, endpoints, payloads, status semantics, and signatures.
- **`capabilities`** — on-ramp, off-ramp, or both; supported entity types and Solana asset rails; `manual_instructions`, `hosted`, or `session_widget` quote delivery.
- **`sandbox`** — credentials, test accounts, rate limits, webhook registration steps, and provider-specific sandbox limitations.

Complete the [ramp intake](https://solanafoundation.typeform.com/to/sxTGbwXt) and follow `apps/sdp-docs/content/docs/reference/provider-onboarding.mdx` before opening the PR. The dashboard ramp flow is active; there is no Payments v2 override cookie.

## Sequence

Do them in this order. For unsupported directions, skip business-flow implementation but still satisfy the required `RampProvider` methods with empty rail/entity support and explicit typed rejection; only `createOnrampQuote` is optional today.

1. **register-provider** — add the id, package client, API schemas/dispatch, availability, setup registry, mode-keyed config, webhook registration decision, and dashboard catalog. Make the skeleton compile.
2. **rail-discovery** — declare which fiat/crypto rails you support.
3. **integrate-estimate** — rate preview; the cheapest live end-to-end check (no DB, no KYC).
4. **counterparty-requirements** — required readiness contract for every provider, including providers that immediately return `ready` or reject an unsupported direction.
5. **integrate-onramp** / **integrate-offramp** — the quote flow(s) for the direction(s) you support.
6. **integrate-webhook** — settlement events and reconciliation.

Adding the id breaks exhaustive registries and switches. Fix those failures without adding fallbacks, then follow `register-provider` for the non-exhaustive schemas, public quote types, translations, and UI catalogs the compiler cannot discover from the new union member alone.

## Reference selection

- `lightspark`: manual instructions plus customer/payout provisioning.
- `moonpay`: hosted quote with no provider-side counterparty provisioning.
- `stripe` or `moneygram`: session-widget quote.
- `bvnk` or `mural`: multi-step onboarding and provider-specific API-side state.

## Rules that aren't optional (shared by every step)

- **Do not default required credentials or required upstream fields.** Explicit product defaults and optional-field fallbacks are acceptable only when their semantics are deliberate and tested; never swallow an upstream failure.
- **HTTP in the provider; DB in the route handler.** Providers read creds from the passed `env` keyed by `mode` and never touch the database.
- **Secrets are environment variables**, mode-keyed where the upstream separates sandbox and production; a missing one throws `providerNotConfigured` → HTTP 503. Never commit credentials.
- **Webhooks are fully typed** — parse the raw body as `unknown` only at the signature boundary, then narrow.
- **Strong typing** — no `any`, no `enum`, finite sets are `as const satisfies Record<…>`.
- **Public contract follows OpenAPI.** When a new provider changes a public request or response shape, update `apps/sdp-api/src/openapi/**` and regenerate owned artifacts rather than editing generated files.
- **Verify the changed surfaces:** `pnpm --filter @sdp/payments typecheck`, `pnpm --filter @sdp/payments lint`, `pnpm --filter @sdp/payments test`, `pnpm --filter @sdp/api typecheck`, and focused API tests. Run web checks when the dashboard catalog or quote renderer changes.

Per-step detail lives in each linked skill.
