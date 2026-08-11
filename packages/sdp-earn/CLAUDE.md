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
laptop — sandbox base URL + `*_SANDBOX_API_KEY` only. Note that dashboard
sessions resolve their environment from the `x-project-id` project
(`@/lib/sdp-environment`), so selecting an org's **production** project —
possible via curl even while the dashboard's switcher stays locked — drives the
provider's production API. Locally, only ever use sandbox projects and never
set a production `*_API_KEY`.

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
  Ground's real yield sources. It fires on the hour, so a freshly started API
  shows nothing until then — seed if you don't want to wait.
- **Offline (no key needed):** `DATABASE_URL=… pnpm -C apps/sdp-api db:seed:earn`
  writes 10 Ground-shaped fixtures (prefixed `seed-demo-`, removable with
  `--clean`, never confusable with synced rows).

Running both is fine but leaves near-twin rows (same vault names, different
reference prefix); `--clean` removes only the fixtures.

See README.md → "Catalogue data: the sync cron vs the dev seed" for cadence,
failure behaviour, and when to prefer each.

### 4b. Get a program — one org, one portfolio wallet

`db:seed:earn` also links your org to a real Ground sandbox portfolio wallet, so
the dashboard opens onto a live program instead of an empty onboarding screen.

**One org gets exactly one program.** That is SDP's product model — the UNIQUE
`(organization_id, environment, provider)` constraint on `earn_provider_wallets`
(migration 0049) — *not* a Ground limit. Ground has no concept of an SDP org and
one Ground account holds many portfolio wallets; every SDP org shares a single
account per environment (`readGroundConfig` resolves one API key, never a per-org
credential). So the sibling wallets you see in Ground's dashboard stand in for
*other* orgs — the seed deliberately does not hand them to yours, and there is no
way to attach several to one org.

This is also why **your local total won't match Ground's dashboard**: Ground's
console sums every wallet in the shared sandbox account, SDP shows only your
org's one wallet. Both numbers are right.

Practical notes:

- **Which org gets it:** the org you sign into (the Clerk-backed one), ahead of
  the `db:seed:local` test fixture. Other local orgs stay unlinked on purpose.
- **Re-run the seed after your first Clerk sign-in.** On a fresh machine the only
  org is the test fixture, so an early seed lands the program there. The seed
  *moves* its own link to follow your real org — but only when you re-run it. A
  program you created through the wizard is never moved.
- **The API-key path has no program.** `db:seed:local`'s dev key belongs to the
  test org, so `curl /v1/earn/program?provider=ground` with it returns 404 by
  design. Use the dashboard, or mint a key for your own org.
- **The seeded program starts at whatever the shared wallet currently holds.**
  It carries a live single-strategy allocation (one strategy at 100% — the
  shape the deposit flow authors), so the overview shows a real forward APY.
  The wallet is shared with teammates and IS funded from time to time for
  exit-path testing, so do not treat any particular balance as the baseline —
  read it from the dashboard. Fund it by sending devnet USDC to the wallet's
  Solana deposit address, which exercises the real two-phase deposit (arrives
  as `cash`, deploys on a later Ground rebalance).
- **Getting devnet USDC: Circle's faucet — <https://faucet.circle.com/>**
  (select **USDC** + **Solana Devnet**, paste the address). It mints the
  official devnet USDC mint (`4zMMC…`, the one pinned in well-known-tokens),
  so faucet funds credit deposits directly. Rate-limited per address.
- **Don't "fix" the $0 by pointing the seed at a funded sandbox wallet.** The
  funded ones hold USDT cash on a non-Solana rail, and Ground enforces the lane
  split at the API: USDC→Solana returns `409 insufficient_funds` (lane
  withdrawable `0`) while USDT is refused on Solana entirely. Because
  `balance.withdrawableUsd` is a wallet-level total and the withdraw modal caps on
  it, such a wallet shows a withdrawable balance SDP cannot withdraw and a "max"
  button that 409s — which reads as an SDP bug and is not one. A zero you can act
  on beats a balance you cannot.

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
| Dashboard shows empty onboarding, but a program exists in the DB | it is linked to another local org — re-run `db:seed:earn` to move it to the org you sign into |
| `GET /v1/earn/program` → 404 with the dev API key | that key is the test org's, which has no program by design (§4b) |
| A key you minted yourself returns `strategies: []` **and** program 404 | the key inherited the **production** environment. An API key has no environment column — it comes from `projects.environment` (the JOIN in `middleware/auth.ts`), and every org has both a `default-sandbox` and a `default-production` project. A key on the production project sees no sandbox catalogue and no sandbox program, which reads as "everything is missing" rather than as a scoping error. Mint against the sandbox project, and refuse anything else: a production key would drive Ground's **production** API from a laptop. |
| Local total ≠ Ground console total | Ground sums the whole shared account; SDP shows your org's one wallet (§4b) |
| Catalogue empty right after boot | sync cron runs on the hour — seed instead of waiting |
| Need devnet USDC to fund a program | Circle's faucet: <https://faucet.circle.com/> — USDC + Solana Devnet (§4b) |

## Contracts

- `EarnVaultProvider` (src/types.ts) is the base contract — slimmed by
  PRO-1628 to `provider` + `declaredSupport` + `listStrategies`, every member
  real and called (the per-strategy quote/execution seams live in git history
  until PRO-1634 gives them a consumer); the portfolio-wallet
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
- **Chain keys are HARD-SET in `GROUND_SOLANA_CHAINS`**
  (providers/ground/client.ts): sandbox = `solana_devnet`, production =
  `solana`. Ground confirmed (2026-08-05) sandbox supports both Ethereum
  Sepolia and Solana devnet — Solana flows in sandbox use the `solana_devnet`
  key. Every wallet flow sends `config.chain` from the constant; no SDP flow
  may ever take a caller-supplied chain. SDP only cares about Solana. Sandbox
  mock USDT and Ground's sandbox faucet (`POST /v2/sandbox/faucets/usdt`) are
  Sepolia-only, so exercising the Solana lane locally means devnet USDC to the
  wallet's deposit address (§4b).
- Withdrawal approval is **policy-conditional, not default** (resolved
  2026-08-05 — README → "Withdrawals unwind in reverse"). A payout leg parked
  in `pending_customer_approval` must surface as the `pending_approval` wire
  status, never as indefinite `processing`; the approval surface is the
  optional capability behind `supportsWithdrawalApprovals` (capabilities.ts).
- Tests: node:test (`pnpm --filter @sdp/earn test`), **no network** — stub
  global fetch per the canonical pattern in src/fetch.test.ts and
  providers/ground/client.test.ts. Every new client method needs mapping +
  error-taxonomy coverage.
- Ground specifics (base URLs, endpoint shapes, apyBps/liquidity/curator
  mapping decisions) are documented in providers/ground/client.ts doc comments
  and README.md — update both when the mapping changes.
- Catalogue coverage questions (what Ground offers vs what distillation
  drops, and why): `pnpm --filter @sdp/api earn:inventory` pulls the raw
  catalogue and regenerates `docs/earn/ground-catalogue-inventory.md` using
  the same `distillGroundYieldSource` the sync uses. Sandbox only from a
  laptop; the production variant is gated behind `--confirm-production`.

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
