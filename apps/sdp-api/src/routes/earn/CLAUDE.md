# /v1/earn routes — agent notes

HTTP surface for SDP Earn. Provider-neutral: handlers resolve clients through
the fail-closed registry and check capabilities — no `if (provider === "ground")`
anywhere. See `packages/sdp-earn/README.md` for architecture; ADR 0002 for
invariants.

## Route map

- `GET /strategies[/:id[/nav]]` — synced catalogue (DB), env-scoped.
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
- `GET /program/deposits`, `POST /program/withdrawal-preview`,
  `POST /program/withdrawals`, `GET /program/withdrawals/:ref` — funding
  tracking + portfolio-level withdrawals (Solana destinations only).
- `GET /positions|/movements` — per-strategy families (currently unused by the
  portfolio flow; kept for per-strategy providers).

## Gate asymmetry — DO NOT BREAK (ADR 0002 exit-safety)

- **Money-in** (`PUT /program`, deposit quotes): `assertProviderAvailable`
  (entitlement + enablement + credentials).
- **Money-out and reads** (withdrawals, previews, GET program, deposits list):
  `assertEarnProviderConfigured` ONLY — a disabled provider must never trap
  funds. Route tests in `../earn.test.ts` / `../earn-program.test.ts` encode
  both halves; if your change breaks one, the change is wrong.

## Conventions

- `EARN_ENABLED` gates the whole family (index.ts), and Earn is a sub-module of
  Markets — `isEarnEnabled` also requires the parent `MARKETS_ENABLED`, so
  clearing that one flag darkens every Markets API surface. Both default off.
  Never re-check Markets in a handler; the hierarchy lives in `isEarnEnabled`.
- Zod schemas in schemas.ts; parse/paginate/envelope helpers in
  handlers/shared.ts — don't hand-roll either.
- Capability gating: `supportsPortfolioWallets(client)` → NOT_IMPLEMENTED for
  providers lacking the surface.
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
