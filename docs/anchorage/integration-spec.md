# Anchorage Custody Integration Spec (SDP)

Date: February 24, 2026
Status: Proposed
Depends on: `docs/anchorage/research.md`

## 1. Problem Statement

SDP needs to integrate Anchorage as a custody provider. Current SDP custody architecture is signer-first:

- Provider abstraction is [`SigningPort`](../../apps/sdp-api/src/services/ports/signing.port.ts)
- Provider routing is in [`signing.service.ts`](../../apps/sdp-api/src/services/domain/signing.service.ts)
- Wallet provider initialization is via [`/v1/wallets/*`](../../apps/sdp-api/src/routes/custody/index.ts)

Anchorage public docs currently expose custody operations APIs (wallets, addresses, transfers, withdrawals, webhooks), but no documented endpoint for arbitrary Solana message signing.

## 2. Decision

Implement Anchorage in two phases:

1. Phase A (now): Operations-mode custody provider (no raw signing dependency)
2. Phase B (optional): Add signer-mode adapter only if Anchorage confirms a raw signing API

This avoids blocking delivery while preserving a clean path to signer parity.

## 3. Goals

- Support Anchorage API auth/signature model safely.
- Support wallet and transfer lifecycle through Anchorage APIs.
- Persist Anchorage request IDs and statuses in SDP.
- Reconcile status asynchronously via Anchorage webhooks.
- Keep current signer-based issuance flows stable.

## 4. Non-Goals (Phase A)

- Replacing existing issuance signer flows with Anchorage.
- Forcing `/v1/payments` to use Anchorage immediately for all orgs.
- Assuming undocumented/private Anchorage signing capabilities.

## 5. High-Level Design

## 5.1 New Anchorage module

Add a dedicated module under:

- `apps/sdp-api/src/services/custody/anchorage/client.ts`
- `apps/sdp-api/src/services/custody/anchorage/types.ts`
- `apps/sdp-api/src/services/custody/anchorage/auth.ts`
- `apps/sdp-api/src/services/custody/anchorage/webhook.ts`

Responsibilities:

- Build signed Anchorage requests (`Api-Access-Key`, `Api-Signature`, `Api-Timestamp`)
- Handle idempotency keys for write operations
- Normalize errors (`errorType`, HTTP code, message)
- Expose typed methods for wallets/addresses/transfers/withdrawals/webhooks

## 5.2 Domain service

Add:

- `apps/sdp-api/src/services/domain/anchorage-custody.service.ts`

Responsibilities:

- Business orchestration for Anchorage operations:
  - initialize provider config
  - sync vaults/wallets
  - create/list transfers and withdrawals
  - poll status where needed
- Map Anchorage entities to SDP wallet/config scope.

## 5.3 Routing

Add dedicated route group (instead of overloading signer routes):

- `apps/sdp-api/src/routes/anchorage/index.ts`
- `apps/sdp-api/src/routes/anchorage/handlers.ts`
- `apps/sdp-api/src/routes/anchorage/schemas.ts`

Register in:

- [`apps/sdp-api/src/index.ts`](../../apps/sdp-api/src/index.ts)

Proposed endpoints:

- `POST /v1/anchorage/initialize`
- `GET /v1/anchorage/vaults`
- `GET /v1/anchorage/wallets`
- `POST /v1/anchorage/wallets/:walletId/addresses`
- `POST /v1/anchorage/transfers`
- `POST /v1/anchorage/withdrawals`
- `GET /v1/anchorage/transactions/:transactionId`

## 5.4 Webhook ingestion

Extend existing webhook router:

- [`apps/sdp-api/src/routes/webhooks/index.ts`](../../apps/sdp-api/src/routes/webhooks/index.ts)

Add:

- `POST /webhooks/anchorage`

Responsibilities:

- Verify webhook signature using Anchorage validation key flow.
- Deduplicate by message ID.
- Update transfer/transaction status in SDP tables.

## 6. Data Model Changes

Add migration (example name):

- `apps/sdp-api/src/db/migrations/0006_anchorage_custody.sql`

## 6.1 Provider metadata for transfers

Extend `payment_transfers` with:

- `provider` (`internal` default, `anchorage`)
- `provider_transfer_id` (nullable)
- `provider_transaction_id` (nullable)
- `idempotency_key` (nullable)
- `provider_payload` (nullable JSON text)

Rationale: keep transfers unified in one table while preserving external IDs.

## 6.2 Anchorage webhook event log

Create `anchorage_webhook_events`:

- `id`
- `message_id` (unique)
- `event_type`
- `received_at`
- `payload` (raw)
- `processed_at`
- `status` (`received|processed|failed`)
- `error` (nullable)

Rationale: reliable replay/debug and deduplication.

## 6.3 Optional wallet binding table

If needed for 1:N mapping:

- `anchorage_wallet_bindings`
  - `id`
  - `custody_wallet_id` (FK to `custody_wallets.id`)
  - `vault_id`
  - `wallet_id`
  - `asset_type`
  - `created_at`
  - unique (`custody_wallet_id`, `wallet_id`)

## 7. Configuration and Secrets

Extend [`Env`](../../apps/sdp-api/src/types/env.d.ts) with Anchorage vars:

- `ANCHORAGE_API_BASE_URL` (optional default to prod/staging by env)
- `ANCHORAGE_API_ACCESS_KEY` (if platform-managed mode is used)
- `ANCHORAGE_API_SIGNING_KEY` (Ed25519 private key if platform-managed)
- `ANCHORAGE_WEBHOOK_VALIDATION_KEY` (optional cache)

If org-managed credentials are required, store encrypted in `custody_configs.config_encrypted` (same pattern as Fireblocks).

## 8. OpenAPI Changes

Add schemas and paths:

- `apps/sdp-api/src/openapi/schemas/anchorage.ts`
- `apps/sdp-api/src/openapi/paths/anchorage.ts`
- register in `apps/sdp-api/src/openapi/spec.ts`

## 9. Rollout Plan

1. Build client + unit tests (auth, signature canonicalization, retries, error mapping).
2. Add initialize/list/read-only endpoints first.
3. Add create transfer/withdrawal endpoints with idempotency support.
4. Add webhook ingestion + reconciliation jobs.
5. Enable in dev/staging with feature flag by organization.
6. Expand to production orgs after stable reconciliation metrics.

## 10. Testing Strategy

- Unit:
  - canonical signature string and Ed25519 signing
  - idempotency key behavior
  - webhook verification and duplicate handling
- Integration:
  - initialize provider config lifecycle
  - transfer create -> status update path
  - webhook update -> payment transfer record transition
- Contract:
  - fixture-based API response parsing for all used Anchorage endpoints

## 11. Risks and Mitigations

- Risk: No raw signing endpoint in public docs.
  - Mitigation: keep signer flows unchanged; design capability gate.
- Risk: webhook signature/key handling errors.
  - Mitigation: strict verification, dead-letter event table, replay support.
- Risk: mixed transfer models (internal Solana tx vs Anchorage transfer object).
  - Mitigation: explicit `provider` field and status mapping per provider.

## 12. Open Questions

1. Does Anchorage provide a private/partner endpoint for raw Solana transaction signing?
2. Should Anchorage credentials be org-managed or platform-managed in SDP?
3. For Phase A, should `/v1/payments` call Anchorage directly when provider is `anchorage`, or should Anchorage be exposed as separate endpoints first?
