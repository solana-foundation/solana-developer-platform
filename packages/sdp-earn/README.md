# @sdp/earn — Earn provider integrations

`@sdp/earn` is the provider-integration layer for SDP Earn (the dashboard's
Markets → Earn module): curated stablecoin yield for org treasuries, fronted by
vault-infrastructure providers. **Ground is the first live provider**; the
architecture is deliberately multi-provider — every Ground-specific detail
lives behind a provider-neutral seam so that adding infra provider #2 (or new
curators, or new vaults) is a contained, checklist-driven change.

Companion docs:

- [ADR 0002 — Earn provider pluggability](../../docs/decisions/0002-earn-provider-pluggability.md)
  (the invariants; includes dated addenda for the backend hardening and the
  Ground portfolio-wallet integration)
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
  (`earn_provider_wallets`, migration 0035).
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
| `allocations[].type` (treasury/CLO vs lending/reserve) | `source_kind`: `rwa` / `defi` (dominant allocation) |
| `mode` | only `active` sources are listed; `buy_only` is excluded (would trap funds — ADR 0002 exit-safety) |
| Portfolio wallet (`POST /v2/wallets`, `GET /v2/wallets/{id}`) | The org's shared program: `earn_provider_wallets.provider_wallet_ref` |
| Strategy weights | `PUT /v1/earn/program` allocations (percent, 0.1 grid, sum = 100 per token group) → Ground target weights |
| `depositAddresses.solana{,_devnet}` | The program's funding address (only Solana is surfaced) |
| Deposits / withdrawals / previews | `GET /v1/earn/program/deposits`, `POST /v1/earn/program/withdrawal-preview`, `POST /v1/earn/program/withdrawals` (idempotent `requestId`) |

Credentials: `GROUND_SANDBOX_API_KEY` (sandbox) / `GROUND_API_KEY`
(production), injected via env (Doppler in deployed environments). With no key
present every call **fails closed** with `PROVIDER_NOT_CONFIGURED` before any
network request, and the dashboard shows a quiet "provider key not configured"
state.

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
  db/migrations/postgres/0034,0035 earn_strategies, earn_positions,
                                   earn_movements, earn_nav_snapshots;
                                   earn_provider_wallets (shared-wallet link).
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
