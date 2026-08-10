# /v1/earn routes — agent notes

HTTP surface for SDP Earn. Provider-neutral: handlers resolve clients through
the fail-closed registry and check capabilities — no `if (provider === "ground")`
anywhere. See `packages/sdp-earn/README.md` for architecture; ADR 0002 for
invariants.

## Route map

- `GET /strategies[/:id[/nav]]` — synced catalogue (DB), env-scoped.
- **`POST /program/withdrawals` needs a retry-stable idempotency key** and
  refuses a request carrying none. The provider dedupes a withdrawal on the
  request id alone and SDP persists no row for one, so that id is the entire
  defence against a retried request paying out twice — a server-minted random
  id is fresh per attempt and would *cause* the double-send. Accepts EXACTLY
  one of `requestId` (UUIDv4) or the `Idempotency-Key` header — both and
  neither are 400s, because no precedence rule can tell which of two sources a
  caller's retry keeps stable, and following the wrong one pays out twice.
  Whichever arrives, `deriveProviderRequestId` hashes it into a stable id
  scoped by the program wallet, so two tenants sharing the provider account
  cannot collide on the same pasted key.
  Ground validates the shape strictly (`400 requestId must be a valid UUID v4`
  on anything else, verified 2026-08-05), which is why that derivation stamps
  version 4 despite being derived rather than random.
- `POST /deposits/quote`, `POST /withdrawals/quote` — per-strategy quoting
  (capability of providers that support it).
- `PUT /program` / `GET /program` — the **shared portfolio wallet**, ONE per
  (org, environment, provider) — unique constraint in `earn_provider_wallets`
  (migration 0049). This is SDP's product model, not a provider limit: one
  provider account can hold many portfolio wallets, and SDP gives each org
  exactly one of them. PUT is idempotent create-or-update: first call creates the
  provider wallet + row (concurrent races surface the unique violation as 409);
  later calls update strategy weights. Allocation weights validate on a 0.1
  grid summing to exactly 100 per token group, and every `yieldSourceId` must
  exist as an **active** synced strategy for that provider+environment.
  Two optional body fields carry real invariants:
  - `requestId` (UUIDv4) is the caller-owned idempotency key, forwarded to the
    provider on BOTH branches. Providers replay the original response for a
    matching payload and conflict on a mismatch, so a client must mint a NEW id
    whenever the allocation changes. Absent ⇒ the provider client mints one per
    call, which is NOT idempotent: a double-submit fires two mutations.
  `label` is write-once: the update branch never forwards it and there is no
  repository update path, so a rename silently no-ops. The row has no mutable
  columns — a source-wallet field was tried and reverted (see the web
  CLAUDE.md), so do not add one without a consumer.
- `GET /program/deposits`, `POST /program/withdrawal-preview`,
  `POST /program/withdrawals`, `GET /program/withdrawals/:ref` — funding
  tracking + portfolio-level withdrawals (Solana destinations only).
- `GET /positions|/movements` — read `earn_positions`/`earn_movements`, tables
  **nothing writes in V1**: their writer was the execution path, which the
  portfolio-wallet model shipped without, so these serve permanently empty
  ledgers. Live truth is the program surface (provider snapshot per request).
  Do not wire writers here, and do not remove the routes, without PRO-1628 —
  that decision (ledger vs live-only) lands as an ADR 0002 addendum; see the
  "Ledger vs live" callout in docs/architecture/earn-v1-data-flow.md.

## Gate asymmetry — DO NOT BREAK (ADR 0002 exit-safety)

- **Money-in** (`PUT /program`, deposit quotes): `assertProviderAvailable`
  (entitlement + enablement + credentials).
- **Money-out and reads** (withdrawals, previews, GET program, deposits list):
  `assertEarnProviderConfigured` ONLY — a disabled provider must never trap
  funds. Route tests in `../earn.test.ts` / `../earn-program.test.ts` encode
  both halves; if your change breaks one, the change is wrong.

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
  repository tests use testcontainers.
