# /v1/earn routes — agent notes

HTTP surface for SDP Earn. Provider-neutral: handlers resolve clients through
the fail-closed registry and check capabilities — no `if (provider === "ground")`
anywhere. See `packages/sdp-earn/README.md` for architecture; ADR 0002 for
invariants (the 2026-08-11 addendum owns the ledger-vs-live rules below).

## Route map — with each route's single source of truth

Every route reads exactly ONE source (DB or live provider) and never blends
them; that is an ADR 0002 addendum acceptance criterion, not a style choice.

- `GET /strategies[/:id]` — **DB** (synced catalogue), env-scoped. Written only
  by the sync cron + the local dev seed.
- `PUT /program` / `GET /program` — the **shared portfolio wallet**, ONE per
  (org, environment, provider) — unique constraint in `earn_provider_wallets`
  (migration 0049). This is SDP's product model, not a provider limit: one
  provider account can hold many portfolio wallets, and SDP gives each org
  exactly one of them. GET is a **live provider** snapshot per request —
  balances/positions/yield are never persisted. PUT is idempotent
  create-or-update: first call creates the provider wallet + row (concurrent
  races surface the unique violation as 409); later calls re-target the
  strategy. **Earn V1 is single-vault (PRO-1667): each token group accepts
  exactly ONE allocation entry**, which the sum-to-100 rule then pins to
  `pct: 100` — one vault per deposit token per program. The weighted
  multi-entry validation (0.1 grid, sum to exactly 100, duplicate check) is
  dormant, not removed: the API side of re-enabling weights post-V1 is
  relaxing the group cap in `schemas.ts` — wire shape and provider contract
  need nothing. Relaxing it alone does NOT ship weights: the dashboard has no
  weight authoring or share display (removed by design), and the cap is what
  keeps the API from accepting portfolios the dashboard cannot manage until
  that work returns. Every `yieldSourceId` must exist as an **active** synced
  strategy for that provider+environment.
  - `requestId` (UUIDv4) is the caller-owned idempotency key, forwarded to the
    provider on BOTH branches. Absent ⇒ the provider client mints one per
    call, which is NOT idempotent: a double-submit fires two mutations.
  - `label` is write-once: the update branch never forwards it and there is no
    repository update path, so a rename silently no-ops.
- `GET /program/deposits` — **live provider** (provider-observed on-chain
  deposits; cursor passthrough). Deposits are customer-initiated, so SDP never
  sees them at intent time — they are deliberately NOT ledgered in V1.
- `POST /program/withdrawal-preview` — **live provider**.
- **`POST /program/withdrawals` — live provider call + SDP ledger write.**
  Needs a retry-stable idempotency key and refuses a request carrying none:
  EXACTLY one of `requestId` (UUIDv4) or the `Idempotency-Key` header — both
  and neither are 400s, because no precedence rule can tell which of two
  sources a caller's retry keeps stable, and following the wrong one pays out
  twice. `deriveProviderRequestId` hashes the key into a stable id scoped by
  the program wallet (two tenants sharing the provider account cannot collide;
  Ground validates the shape strictly — v4 only, verified 2026-08-05).
  Since PRO-1628 the defence is TWO-layer: the derived id anchors an SDP
  intent row in `earn_program_withdrawals` — unique per (wallet, request_id),
  wallet-scoped because sibling projects share the program — with a payload
  fingerprint that answers a replay from our own ledger (200, live state) and
  409s key-reuse-with-different-payload BEFORE any provider call. The
  provider's own request-id dedupe closes the crash window between our insert
  and its acceptance. A ledger write that fails AFTER provider acceptance
  never fails the response (money moved): it retries, then logs
  `earn_ledger_write_failed`. Heal semantics are narrow: the detail poll heals
  only rows that already carry `provider_reference`; a ref-less row heals via
  a same-key retry or the ledger sweep — never fuzzy matching. NOTE for the
  sweep (hard requirement, from review): a ref-less `requested` row can also
  be a definitively-rejected intent (provider 4xx rethrows and leaves the row
  untouched) — the sweep must discriminate or verify with the provider before
  re-driving, or it could execute an intent the caller abandoned.
- `GET /program/withdrawals/:ref` — **live provider**, and persist-on-
  observation: the response is always the provider's live object; the matching
  ledger row (found via the global (provider, provider_reference) unique) is
  advanced best-effort as a side effect. Unknown refs serve live state and
  touch nothing (pre-ledger withdrawals must keep polling fine). A **BOLA
  guard** runs before the provider call: a ref the ledger knows belongs to
  another organization 404s here — every org shares one provider account, so
  cross-tenant scoping is SDP's job, never delegated to the provider's own
  path scoping.
- `GET /program/withdrawals` — **DB ledger list** (`earn_program_withdrawals`),
  the house `{withdrawals, total, page, pageSize}` envelope, wallet-scoped so
  one program = one history across sibling projects. Deliberately takes NO
  provider gate — not even the credential check — because the audit trail must
  outlive credential removal (the registry-gated provider query param is
  request validation, not availability).
- The status machine + appliers live in
  `services/earn-withdrawal-ledger.service.ts` (Hono-free on purpose: the
  ledger sweep job and future webhooks consume it too). Terminal set is the
  shared `EARN_TERMINAL_WITHDRAWAL_STATUSES` in `@sdp/types` — also consumed
  by the dashboard's outcome polling; never redeclare it.
- Removed by PRO-1628 (do not resurrect without a new decision):
  `GET /positions|/movements` (empty ledgers nothing wrote),
  `POST /deposits/quote|/withdrawals/quote` (501 for every provider — no
  provider ever implemented per-strategy quoting), and
  `GET /strategies/:id/nav` (no writer, no reachable reader). A regression
  test in `../earn.test.ts` pins all of them at 404.

## Gate asymmetry — DO NOT BREAK (ADR 0002 exit-safety)

- **Money-in** (`PUT /program`): `assertProviderAvailable`
  (entitlement + enablement + credentials).
- **Money-out and live reads** (withdrawals create/detail, previews, GET
  program, deposits list): `assertEarnProviderConfigured` ONLY — a disabled
  provider must never trap funds.
- **The ledger list**: no provider gate at all (see route map).
- Route tests in `../earn-program.test.ts` encode the asymmetry: the money-in
  half ("blocks PUT when the organization is not entitled or credentials are
  missing") and the money-out half (the "withdrawals (ADR 0002 exit safety)"
  describe, plus the credentials-absent ledger-list case). The per-strategy
  quote exit-safety tests left with the quotes surface.

## Conventions

- Environment resolution is the shared `@/lib/sdp-environment` helper: API-key
  callers use the key's (project-derived) environment; dashboard/session
  callers use the membership-verified `x-project-id` project's environment; a
  request with neither fails closed (500), never defaults to sandbox. A
  production-project dashboard session therefore drives provider production.
- `EARN_ENABLED` gates the whole family (index.ts), and Earn is a sub-module of
  Markets — `isEarnEnabled` also requires the parent `MARKETS_ENABLED`, so
  clearing that one flag darkens every Markets API surface. Both default off.
  Never re-check Markets in a handler; the hierarchy lives in `isEarnEnabled`.
- Zod schemas in schemas.ts; parse/paginate/envelope helpers in
  handlers/shared.ts — don't hand-roll either.
- Capability gating: `supportsPortfolioWallets(client)` → NOT_IMPLEMENTED for
  providers lacking the surface.
- Withdrawal approval is a SECOND optional capability
  (`supportsWithdrawalApprovals`) with **no public route on purpose**: casting
  a vote needs the account-level Turnkey signer (platform ops — one shared
  Ground account per environment), so exposing list/request/vote under
  `/v1/earn` would hand org API keys an approval surface they must never
  hold. Orgs see a parked withdrawal as `status: pending_approval` on
  `GET /program/withdrawals/:ref` (derived by the provider client from payout
  legs; approval is policy-conditional, not default — see
  `packages/sdp-earn/README.md` → "Withdrawals unwind in reverse").
- Provider ids from DB rows are open strings — always dispatch via
  `resolveEarnProviderClient`.
- Catalogue writes happen ONLY via the sync cron
  (`src/cron/earn-catalogue-sync.ts` — the production path) and the dev seed
  (`db:seed:earn` — local only, refuses non-local databases). Cadence, failure
  behaviour, and which to use: `packages/sdp-earn/README.md` → "Catalogue data".
- Whole-stack local setup (ports, flags, Ground key, entitlement, troubleshooting):
  `packages/sdp-earn/CLAUDE.md` → "Local development".
- Tests: vitest; stub `EARN_PROVIDER_CLIENTS.<id>` methods with `vi.spyOn`;
  repository tests use testcontainers. The ledger repository/service suites in
  `../../db/repositories/earn.repository.test.ts` run against a NON-Ground
  stub id on purpose — the ledger consumes only the canonical contract, and
  that suite is the pluggability proof.
