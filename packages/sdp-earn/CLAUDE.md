# @sdp/earn — agent notes

Provider-integration layer for SDP Earn, **and the canonical local-dev runbook
for the whole Earn stack** (API + web + DB + provider). Ground is the first live
provider; the design is multi-provider — keep every provider-specific detail
behind the provider-neutral seams below. Read `README.md` here for the full
architecture (including Ground's on-chain flow and the custody boundary);
ADR 0002 (`docs/decisions/`) for the invariants.

## Local development — the whole Earn stack

**Absolute rule: local resources only.** Never point any of this at a shared or
production database, and never exercise a provider's production API from a
laptop — sandbox base URL + `*_SANDBOX_API_KEY` only.

### 1. Infrastructure

Postgres and Redis both run in Docker. Other projects commonly squat 5432/6379,
so Earn's local stack uses shifted ports:

```bash
docker run -d --name sdp-postgres-earn -p 5433:5432 \
  -e POSTGRES_DB=sdp -e POSTGRES_USER=sdp -e POSTGRES_PASSWORD=sdp postgres:16-alpine
docker run -d --name sdp-redis-earn -p 6380:6379 redis:7-alpine
```

Redis is **not optional**: the API's rate limiter needs it, and without it every
request 500s (a failure that looks like an app bug and is not).

Then migrate + seed the org/user/project/API-key fixtures:

```bash
cd apps/sdp-api
DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5433/sdp pnpm db:postgres:bootstrap
DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5433/sdp pnpm db:seed:local
```

### 2. Secrets and flags

- **Ground sandbox key** → `apps/sdp-api/.env.local` (gitignored; the Doppler
  wrapper overlays `apps/*/.env.local` on top of Doppler values):

  ```
  GROUND_SANDBOX_API_KEY=<sandbox token>
  ```

- **Module flags** must be set explicitly — both default to `false` and there is
  no dev-only default-on: `MARKETS_ENABLED=true` and `EARN_ENABLED=true`, needed
  by **both** apps (same unprefixed names). Under the Doppler wrapper, plain
  shell exports are ignored unless named in `DOPPLER_PRESERVE_ENV`.

### 3. Run it

```bash
DOPPLER_PRESERVE_ENV=DATABASE_URL,REDIS_URL,MARKETS_ENABLED,EARN_ENABLED \
  DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5433/sdp \
  REDIS_URL=redis://127.0.0.1:6380 \
  MARKETS_ENABLED=true EARN_ENABLED=true \
  pnpm dev:api:local          # API on :8787

DOPPLER_PRESERVE_ENV=NEXT_PUBLIC_SDP_API_BASE_URL,MARKETS_ENABLED,EARN_ENABLED \
  NEXT_PUBLIC_SDP_API_BASE_URL=http://127.0.0.1:8787 \
  MARKETS_ENABLED=true EARN_ENABLED=true \
  pnpm dev:web                # web on :3000
```

A `.claude/launch.json` (untracked) encodes both for the editor's preview
runner. Doppler supplies Clerk keys, so the dashboard needs `doppler login`.

### 4. Get catalogue data — two independent paths

- **Live (real Ground data):** with the sandbox key set and both flags on, the
  hourly catalogue-sync cron registers and populates `earn_strategies` from
  Ground's real yield sources.
- **Offline (no key needed):** `DATABASE_URL=… pnpm -C apps/sdp-api db:seed:earn`
  writes 10 Ground-shaped fixtures (prefixed `seed-demo-`, removable with
  `--clean`, never confusable with synced rows).

See README.md → "Catalogue data: the sync cron vs the dev seed" for cadence,
failure behaviour, and when to prefer each.

### 5. The last gate: org entitlement

Flags control *visibility*; earn access is **override-only per organization**
(`providerOverrides.earn.<provider>`). With flags on, a key set, and no override,
the UI reaches the flow and the API refuses with "requires manual activation" —
that is correct, not a bug. Grant the override in the **local** DB to proceed.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Every request 500s | Redis missing/wrong port (rate limiter) |
| `/v1/earn/*` → 403 | `MARKETS_ENABLED` or `EARN_ENABLED` unset/false |
| `/dashboard/markets/earn` → 404 | same flags, web side (segment guards) |
| Dashboard "provider not configured" (503) | no `GROUND_SANDBOX_API_KEY` |
| "requires manual activation" | org lacks the earn provider override |
| API waits then dies on boot | `DATABASE_URL` not preserved → Doppler's Cloud SQL URL won |
| Web typecheck fails in `.next/dev/types` | stale generated cache: `rm -rf apps/sdp-web/.next/dev/types` |

## Contracts

- `EarnVaultProvider` (src/types.ts) is the base contract; the portfolio-wallet
  surface (`EarnPortfolioWalletProvider`) is an **optional capability** detected
  via `supportsPortfolioWallets()` (src/capabilities.ts, all-or-nothing method
  presence). New optional surfaces follow the same pattern: interface extension
  + type guard in capabilities.ts — never `instanceof` or provider-id checks.
- All USD/amount values in contract types are **decimal strings**; convert to
  wire numbers only at the provider HTTP boundary.
- Registry: `EARN_PROVIDER_CLIENTS` (src/index.ts) + fail-closed
  `resolveEarnProviderClient` — DB provider ids are open strings and MUST be
  resolved through this, never direct-indexed.

## Hard invariants (ADR 0002)

- **Money out beats money off**: nothing in this package may make withdrawals
  depend on availability/enablement — only on configured credentials.
- Catalogue mapping must exclude anything that would trap funds (Ground:
  `mode === "buy_only"` sources are skipped, only `active` is listed).
- Missing API key ⇒ throw `PROVIDER_NOT_CONFIGURED` **before** any network call.

## Conventions

- New provider = subclass `providers/stub.ts` (`StubEarnClient`), register in
  `EARN_PROVIDER_CLIENTS`, add the `./providers/<id>/client` package export.
  A registry-consistency test in src/index.test.ts fails if any of these is
  missing for an id in `EARN_PROVIDERS`.
- All HTTP goes through `providerFetch`/`providerFetchJson` (src/fetch.ts) —
  never raw `fetch` in a client.
- Tests: node:test (`pnpm --filter @sdp/earn test`), **no network** — stub
  global fetch per the canonical pattern in src/fetch.test.ts and
  providers/ground/client.test.ts. Every new client method needs mapping +
  error-taxonomy coverage.
- Ground specifics (base URLs, endpoint shapes, apyBps/liquidity/curator
  mapping decisions) are documented in providers/ground/client.ts doc comments
  and README.md — update both when the mapping changes.

## Cross-package coupling

- Wire DTOs shared with API/web live in `packages/sdp-types/src/earn.ts`.
- Curators/categories are open-string registries in `@sdp/types` — adding one
  is a data change; do not introduce closed curator unions anywhere.
- Env credential names follow `<PROVIDER>_API_KEY` / `<PROVIDER>_SANDBOX_API_KEY`;
  a drift test in apps/sdp-api asserts turbo.json + secret-keys.mjs carry them.
- Module gating is not this package's job. `MARKETS_ENABLED` (parent) and
  `EARN_ENABLED` (child, requires the parent) are read only by the API gate
  (`isEarnEnabled`) and the web flags — a client here gates on credentials
  alone and must never read a feature flag.
