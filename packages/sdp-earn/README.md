# @sdp/earn — Earn provider integrations

`@sdp/earn` is the provider-integration layer for SDP Earn (the dashboard's
Markets → Earn module): curated stablecoin yield for org treasuries, fronted by
vault-infrastructure providers. **Ground is the first live provider**; the
architecture is deliberately multi-provider — every Ground-specific detail
lives behind a provider-neutral seam so that adding infra provider #2 (or new
curators, or new vaults) is a contained, checklist-driven change.

Companion docs:

- [ADR 0002 — Earn provider pluggability](../../docs/decisions/0002-earn-provider-pluggability.md)
  (the invariants; includes dated addenda for the backend hardening, the
  Ground portfolio-wallet integration, and the Markets/Earn flag hierarchy)
- [Earn V1 data flow](../../docs/architecture/earn-v1-data-flow.md) (sequence
  diagrams for catalogue sync, program upsert, funding, withdrawal)
- [Earn pluggability playbook](../../docs/contributing/earn-pluggability-playbook.md)
  (step-by-step: add a provider / vault / category / custodian)

## The product model (V1, Ground)

- **Curators, not vaults, are the primary decision.** Users pick the team that
  manages the allocation (Steakhouse, Gauntlet, …). Curators are **open-string
  data** derived from provider catalogue metadata — onboarding a curator is a
  data change, zero code (see `EARN_KNOWN_CURATOR_LABELS` in `@sdp/types`).
- **One shared portfolio wallet per (organization, environment, provider).**
  Choosing a curator (optionally with a custom split) sets the shared wallet's
  strategy weights. Enforced by a DB unique constraint
  (`earn_provider_wallets`, migration 0049). This is SDP's product model, not a
  provider constraint: Ground has no concept of an SDP organization, one Ground
  account holds many portfolio wallets, and every SDP org shares a single account
  per environment. A provider account's other wallets therefore belong to other
  orgs — which is why a provider console's account-wide total will exceed what any
  one org sees in SDP.
- **Solana-only surface.** Deposits are funded by sending USDC/USDT on Solana
  to the wallet's deposit address (`solana_devnet` in sandbox, `solana` in
  production); withdrawals settle to a Solana address the org controls. Ground
  routes capital to yield sources on other chains internally — that is
  provider plumbing, never exposed in SDP's product surface.
- **Funding is address-based in V1**: show the deposit address, track incoming
  deposits via the provider's deposits API. No custody signing in the flow.
  Webhooks (Ground supports Stripe-style HMAC) are future work; V1 polls.

## How Ground is wired

Ground's [Portfolio Wallets API](https://docs.groundtech.co/docs/portfolio-wallets/introduction)
(sandbox `https://sandbox.groundtech.co`, production
`https://production.groundtech.co`, Bearer auth):

| Ground concept | SDP mapping |
|---|---|
| Yield source (`GET /v2/wallets/yield-sources`) | `earn_strategies` row (`provider='ground'`, `provider_reference=` yield-source id) via the hourly catalogue-sync cron |
| `apyBps` | `current_apy` decimal string (integer math, `356 → "0.0356"`) |
| `processingPolicies.redeem` | `liquidity_term`: `instant` when 0, else `delayed` + `redemption_delay_days` (ceil to days) |
| Yield-source id / name / protocol | `risk_metadata.curator` (known ids → `morpho-<curator>-<token>` convention → protocol fallback) |
| `allocations[].type` (observed: `market`, `liquidity`, `loan`, `reserve`, `rwa`, `treasury`) | `source_kind`: `rwa` / `defi` (dominant allocation; `rwa` + `treasury` are the RWA side) |
| `mode` | only `active` sources are listed; `buy_only` is excluded (would trap funds — ADR 0002 exit-safety) |
| Portfolio wallet (`POST /v2/wallets`, `GET /v2/wallets/{id}`) | The org's shared program: `earn_provider_wallets.provider_wallet_ref` |
| Strategy weights | `PUT /v1/earn/program` allocations (percent, 0.1 grid, sum = 100 per token group) → Ground target weights. Takes an idempotent `requestId` forwarded on BOTH branches (`POST /v2/wallets` on create, `PATCH /v2/wallets/{id}/strategy` on update) — Ground replays a matching payload and **409s a reused key with a changed payload**, so callers must re-mint whenever the allocation changes. An omitted token lane is preserved, not cleared. |
| `depositAddresses.solana{,_devnet}` | The program's funding address (only Solana is surfaced) |
| Deposits / withdrawals / previews | `GET /v1/earn/program/deposits`, `POST /v1/earn/program/withdrawal-preview`, `POST /v1/earn/program/withdrawals` (idempotent `requestId`) |

Credentials: `GROUND_SANDBOX_API_KEY` (sandbox) / `GROUND_API_KEY`
(production), injected via env (Doppler in deployed environments). With no key
present every call **fails closed** with `PROVIDER_NOT_CONFIGURED` before any
network request, and the dashboard shows a quiet "provider key not configured"
state.

## Ground portfolio wallets: keys, on-chain flow, and what SDP does not do

This is the part to understand before touching deposits or withdrawals.

### What a portfolio wallet is

One Ground portfolio wallet = one org's shared Earn program (SDP stores the
handle in `earn_provider_wallets`). It is an **on-chain custodial address** that
holds both idle stablecoins and the yield-bearing positions bought with them.
Its **private keys live in Turnkey**, and Ground signs against the wallet's
configured Turnkey policies — Ground states it never holds raw signing keys.
Ground provisions **per-chain deposit addresses**; SDP surfaces only the Solana
one (`solana_devnet` in sandbox, `solana` in production).

### The on-chain contract stack

| Component | Role |
|---|---|
| **Portfolio Wallet** | Holds cash + yield positions; the address customers fund |
| **MasterRouter** | Executes allocation and withdrawal actions |
| **AdapterRegistry** | Maps an approved yield source to its adapter |
| **Protocol Adapters** | Direct DeFi integrations (Morpho, Kamino, Aave, …) |
| **Ground RWA Vaults** | RWA sources; **async**, and they issue a wallet-specific *non-transferable* Ground receipt rather than the underlying instrument |

### Deposits are two-phase (this is why `cash` exists)

1. A customer sends USDC/USDT on Solana to the wallet's deposit address —
   an ordinary SPL transfer, initiated from **their** custody (Fireblocks,
   Anchorage, …). SDP builds and signs nothing.
2. Ground detects it and the funds land as **cash** in the portfolio wallet.
3. A **later Ground-managed rebalance** deploys that cash per the strategy
   weights: `Portfolio Wallet → MasterRouter → AdapterRegistry → Protocol
   Adapter → protocol` (the yield-bearing token stays in the portfolio wallet),
   or `→ Ground RWA Vault → RWA provider` for RWA sources.

So a fresh deposit legitimately shows as **cash, not yet earning**, until the
rebalance runs. Our `EarnPortfolioPositionKind` values map directly onto these
real on-chain states:

| Position kind | On-chain meaning |
|---|---|
| `cash` | Received, not yet deployed (awaiting rebalance) |
| `yield_source` | Deployed into a yield source; token held by the wallet |
| `bridge` | Mid-flight across a CCTP domain |
| `external_payout` | Leaving toward a withdrawal destination |
| `unknown` | Forward-compatible fallback (never guess) |

Position **labels** are synthesized from kind + token, not passed through:
Ground names a position after the chain its value currently sits on (e.g. idle
cash reads `"USDT (Ethereum Sepolia)"`), and no other chain may reach a wire type
or the UI (invariant 5). Only `yield_source` keeps the provider's label — that is
the vault's product name, carries no chain, and is what a reader matches to the
catalogue. The value is never hidden, only the chain wording: off-rail cash still
counts toward the wallet total Ground reports, so dropping the position would
leave a total its positions don't sum to.

### Cross-chain: token lanes are preserved

Ground never converts between USDC and USDT. USDC may bridge **within CCTP
domains**; USDT stays on Ethereum. That is why USDT is production-only in our
declared support, and why `bridge` is a first-class position kind. SDP's product
surface stays Solana-only — the other chains are provider plumbing.

### Withdrawals unwind in reverse — and need an approval we have NOT built

Redemption reverses the flow: vaults settle, the wallet claims stablecoin, and
Ground pays out to the destination address. Payout legs may settle at different
times, and **each leg requires its own approval**.

> **Known gap.** Ground's approval model is customer-controlled Turnkey signing:
> *"Ground does not stamp the Turnkey approval for you."* The customer's signer
> produces the stamp off Ground's servers via
> `GET /v2/turnkey/activities/pending` →
> `POST /v2/turnkey/activity-approval-request` → local stamp →
> `POST /v2/turnkey/activities/{activityId}/vote`.
> **`GroundEarnClient` implements none of those.** We submit
> `POST …/withdrawals` and poll status, so a submitted withdrawal may park in
> pending approval. Ground's docs do not say whether customer-side signing is
> mandatory or only applies when signing keys are configured, nor what a new
> wallet defaults to. Resolve empirically — create a sandbox wallet, submit a
> withdrawal, observe — before anyone relies on the exit path.

### Custody boundary (say this out loud to customers)

SDP never holds keys, never signs, and never constructs a transfer in V1.
Funding is customer-initiated from their own custody to a stable address they
whitelist once; withdrawals return to a Solana address they control. **While
deployed, funds sit in Ground's Turnkey-managed wallet, not the customer's
custodian** — that is inherent to an omnibus portfolio-wallet product and is a
compliance decision for mandates that require assets to stay with a qualified
custodian. Future work (documented in ADR 0002) is initiating the funding
transfer in-flow via the customer's connected Fireblocks workspace; Anchorage is
lifecycle-only in SDP's signing registry today and would need adapter work.

## Rollout gating (pre-release)

Earn is the child in a two-level module flag hierarchy: `MARKETS_ENABLED`
(parent — the whole Markets module) and `EARN_ENABLED` (child — the Earn
sub-module). Earn needs **both**, and both default to **false** everywhere, so
a deployed environment stays dark until it is switched on. `sdp-api` and
`sdp-web` read the same unprefixed names; there is no `NEXT_PUBLIC_*` twin.
API-side the hierarchy is owned by `isEarnEnabled`
(`apps/sdp-api/src/lib/feature-flags.ts`); web-side the two flags declared in
`apps/sdp-web/src/flags.ts` gate the nested route segments
(`dashboard/markets/layout.tsx` → `markets/earn/layout.tsx`). The flags are
module visibility, not the provider on/off lever — see the ADR 0002 addendum.

## Architecture: where everything lives

```
packages/sdp-types/src/earn.ts     Wire DTOs shared by API + web: strategies,
                                   portfolio wallet snapshot/balance/positions,
                                   deposits, withdrawals, allocation inputs,
                                   open curator/category registries.

packages/sdp-earn/src/
  types.ts                         Provider contracts. EarnVaultProvider (base:
                                   listStrategies/getNav/quotes) and the
                                   OPTIONAL EarnPortfolioWalletProvider
                                   capability (create/get wallet, update
                                   strategy, deposits, withdrawal preview/
                                   create/status, address book).
  capabilities.ts                  supportsPortfolioWallets() type guard —
                                   capability detection is all-or-nothing.
  index.ts                         EARN_PROVIDER_CLIENTS registry + fail-closed
                                   resolveEarnProviderClient (unknown/drifted
                                   provider ids never dispatch).
  fetch.ts                         providerFetch/providerFetchJson — the single
                                   HTTP funnel (status → error taxonomy).
  errors.ts                        SdpEarnError taxonomy.
  support.ts                       Declared-support validation: catalogue rows
                                   outside a provider's declared envelope are
                                   drift, not data.
  nav.ts                           Share-price/NAV bigint math.
  providers/stub.ts                StubEarnClient — every method NOT_IMPLEMENTED;
                                   a new provider starts as a ~10-line subclass.
  providers/ground/client.ts       The live Ground integration (catalogue
                                   mapping + full portfolio capability).
  providers/{veda,upshift,perena}/ Registered scaffolds awaiting integrations.

apps/sdp-api/src/
  routes/earn/                     /v1/earn HTTP surface. handlers/program.ts is
                                   the shared-wallet family; strategies/
                                   positions/movements/quotes are the
                                   catalogue + per-strategy families.
  db/migrations/postgres/0048,0049 earn_strategies, earn_positions,
                                   earn_movements, earn_nav_snapshots (0048);
                                   earn_provider_wallets (0049, shared-wallet
                                   link).
  db/repositories/earn.*           Row types + Postgres impl (open-string
                                   provider columns; dispatch must go through
                                   the fail-closed resolver).
  cron/earn-catalogue-sync.ts      Hourly sync: every registered provider's
                                   listStrategies → upsert, per-provider
                                   failure isolation, declared-support checks.
  services/provider-availability   Credential definitions + the two gates (see
                                   invariants below).

apps/sdp-web/src/app/
  dashboard/markets/earn/          The dashboard module: earn-workspace
                                   (overview), deposit/ (wizard + funding),
                                   earn-withdraw-modal, earn-program-data
                                   (SWR seam over the BFF), presentation
                                   helpers. All live data — no mocks.
  api/dashboard/markets/earn/      BFF proxies to /v1/earn/*.
```

## Catalogue data: the sync cron vs the dev seed

Two things write `earn_strategies`, and only one of them is a production path.

### The sync cron — the production path

`apps/sdp-api/src/cron/earn-catalogue-sync.ts`

- **What it does:** walks every client in `EARN_PROVIDER_CLIENTS`, calls
  `listStrategies` per environment (sandbox + production), validates each row
  against the provider's declared support, and upserts on
  `(provider, provider_reference, environment)`.
- **When it runs:** hourly (`EARN_CATALOGUE_SYNC_CRON = "0 * * * *"`), and it is
  **registered only when the Markets/Earn flag gate passes** (`isEarnEnabled` in
  `cron/runner.ts`) — so it is completely inert in a flag-off environment.
- **Failure behaviour:** per-provider isolation. `NOT_IMPLEMENTED` and
  `PROVIDER_NOT_CONFIGURED` are info-level skips (that is the normal state for
  the stub providers); any other error is logged for that provider and never
  sinks the others.
- **Adding a provider needs no cron change** — it is registry-driven.
- **To change cadence:** edit `EARN_CATALOGUE_SYNC_CRON`.
- **An operator stop outranks the sync.** The upsert never overwrites a
  `paused`/`deprecated` status, so an emergency pause holds until someone writes
  the status back to `active` — a sync pass can no longer resurrect it. Metadata
  and rates keep converging while the row is closed.
- **Known limitation:** rows a provider *delists* keep their last status (there
  is no deactivation-of-missing-rows pass yet), so a vault that silently
  disappears from a provider's catalogue stays `active` until someone acts.

### The dev seed — local development only

`apps/sdp-api/scripts/seed-earn-demo.ts` (`pnpm -C apps/sdp-api db:seed:earn`)

- **Local only, enforced.** It refuses any `DATABASE_URL` whose host is not
  `localhost` / `127.0.0.1` / `::1`, and it only ever writes `sandbox` fixtures
  (the old `--environment production` flag is gone and now exits with an error).
  It is never run by CI or any deploy.
- **Why it exists:** browse a populated catalogue without a Ground API key and
  without waiting for the cron; deterministic data for demos and UI work.
- **What it seeds:** 10 fixtures whose ids/names/APYs/liquidity/curators mirror
  Ground's real sandbox catalogue (so local dev looks like production), plus NAV
  history, plus exactly one **paused** row (`ground-jtrsy-usdc-vault`) that
  exercises the ADR 0002 exit-safety split — deposits blocked, withdrawals still
  quotable.
- **Fixtures are labelled, never confused with real data:** every seeded row
  carries the `seed-demo-` `provider_reference` prefix and
  `riskMetadata.seedFixture`. `--clean` deletes **only** prefixed rows, so it can
  never remove a row the live cron synced.
- **It also links one program, and that part is NOT a fixture.** The seed points
  your primary local org at one of the team's real Ground *sandbox* portfolio
  wallets, so the dashboard opens onto live provider state (real allocation, real
  forward APY, a real Solana deposit address) rather than an empty onboarding
  screen. One org, one program — the same unique constraint production enforces,
  so the seed never hands an org a second wallet, and other local orgs stay
  unlinked. The wallet is shared with teammates: funding it, re-weighting it
  through the wizard, or withdrawing from it changes what they see. Re-run the
  seed after your first Clerk sign-in and it moves its own link onto your real
  org; a program you created through the wizard is never moved. `--clean` removes
  the link, never the Ground wallet.
  The seeded program starts at **$0** deliberately — it is an all-Solana/USDC
  wallet you fund yourself via its devnet deposit address. Pointing the seed at a
  funded sandbox wallet instead would surface a withdrawable balance SDP cannot
  withdraw, because those balances sit off the Solana rail while
  `balance.withdrawableUsd` reports a wallet-level total.
  Full local-dev detail: `CLAUDE.md` → "Get a program — one org, one portfolio
  wallet".
- **Commands**

  ```bash
  DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5433/sdp pnpm -C apps/sdp-api db:seed:earn
  DATABASE_URL=... pnpm -C apps/sdp-api db:seed:earn -- --days 30   # longer NAV history
  DATABASE_URL=... pnpm -C apps/sdp-api db:seed:earn -- --clean     # remove the fixtures
  ```

  Idempotent: re-running upserts in place (ids stay stable, no duplicates).
- **When *not* to use it:** never against a shared or deployed database. If you
  have a Ground sandbox key, prefer the real cron path — and note that running
  both leaves near-twin rows in your local DB (same names, different reference
  prefix); `--clean` removes the fixtures and leaves the synced rows.

## Invariants (do not break)

1. **Money out beats money off.** Deposit-side operations (`PUT /program`,
   deposit quotes) gate on full provider *availability* (entitlement +
   enablement + credentials). Withdrawal and read paths gate only on
   *configured credentials* — disabling a provider must never trap funds.
2. **Fail closed on drift.** Provider ids from the DB are open strings; all
   dispatch goes through `resolveEarnProviderClient`, which throws on unknown
   ids rather than guessing.
3. **Reads never gate on availability.** The catalogue and program snapshots
   stay readable while a provider is disabled.
4. **Declared support bounds the catalogue.** A synced strategy outside the
   provider's declared token/source envelope is rejected and logged, not
   persisted.
5. **Solana-only surface.** No other chain's addresses or rails may leak into
   wire types or UI.

## Adding a provider (the 30-second version)

The compiler and tests enforce most of this; the
[playbook](../../docs/contributing/earn-pluggability-playbook.md) has the full
walk with the Ground integration as the worked example:

1. Add the id to `EARN_PROVIDERS` (`@sdp/types/provider-access`) — every
   `satisfies Record<EarnProviderId, …>` now errors until you finish.
2. Subclass `StubEarnClient` in `providers/<id>/client.ts`; register it in
   `EARN_PROVIDER_CLIENTS`; add the package.json subpath export (a
   registry-consistency test fails if you forget).
3. Add the credential pair to env plumbing (`env.d.ts`, `turbo.json`,
   `scripts/secret-keys.mjs` — a drift test fails if you forget) and a
   one-line `keyPairCredentialDefinition` availability entry.
4. Implement capabilities method-by-method (`listStrategies` first — the sync
   cron picks it up automatically). If the provider is portfolio-based,
   implement `EarnPortfolioWalletProvider`; the program routes light up via the
   capability guard, no route changes.
5. Tests are no-network by design: stub `fetch` per the canonical pattern in
   `src/fetch.test.ts` / `providers/ground/client.test.ts`.

Curators and vault/category changes require **no code at all** — they are
catalogue data (see the playbook).

## Testing

```bash
pnpm --filter @sdp/earn test        # node:test, no network (fetch stubbed)
pnpm --filter @sdp/earn typecheck
```

API-layer earn tests (routes, repository, availability) live in
`apps/sdp-api` and run under vitest + testcontainers; web module tests live in
`apps/sdp-web/src/app/dashboard/markets/earn`.
