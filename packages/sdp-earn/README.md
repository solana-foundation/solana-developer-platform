# @sdp/earn — Earn provider integrations

`@sdp/earn` is the provider-integration layer for SDP Earn (the dashboard's
Markets → Earn module): curated stablecoin yield for org treasuries, fronted by
vault-infrastructure providers. **Ground is the first live provider**; the
architecture is deliberately multi-provider — every Ground-specific detail
lives behind a provider-neutral seam so that adding infra provider #2 (or new
curators, or new vaults) is a contained, checklist-driven change.

Two provider SHAPES now live here, and the difference decides which seams a new
integration touches:

| | **Custodial portfolio** (Ground) | **Catalogue-only** (Kamino) |
|---|---|---|
| Money model | SDP provisions an omnibus wallet; the provider spreads funds across sources | Non-custodial — the customer's own wallet deposits into an on-chain vault |
| Contract | `EarnVaultProvider` + `EarnPortfolioWalletProvider` (+ approvals) | `EarnVaultProvider` + `EarnLiveMetricsProvider` |
| `/v1/earn/programs` | the whole flow | **501** by capability detection |
| Credential | `GROUND_API_KEY` / `GROUND_SANDBOX_API_KEY` | none — public data API |
| Clusters | catalogued per environment's own cluster | **mainnet only**, catalogued into both |
| Dashboard | the deposit wizard | not shown — API surface only |

A catalogue-only provider is a complete integration, not a partial one: there is
no wallet to provision, so `supportsPortfolioWallets` returning false is the
answer, not a TODO. See CLAUDE.md → "Two provider shapes".

Companion docs:

- [ADR 0002 — Earn provider pluggability](../../docs/decisions/0002-earn-provider-pluggability.md)
  (the invariants; includes dated addenda for the backend hardening, the
  Ground portfolio-wallet integration, and the Markets/Earn flag hierarchy)
- [Earn V1 data flow](../../docs/architecture/earn-v1-data-flow.md) (sequence
  diagrams for catalogue sync, program create/re-target, funding, withdrawal)
- [Earn pluggability playbook](../../docs/contributing/earn-pluggability-playbook.md)
  (step-by-step: add a provider / vault / category / custodian)

## The product model (V1, Ground)

- **One strategy is the whole decision.** The wizard runs funding wallet →
  profile → filtered catalogue → one strategy; there is no curator step, because
  picking a house first gated the catalogue behind a choice the reader had no
  facts to make. Curator is metadata rendered beside a strategy, never a gate —
  but still **open-string data** derived from provider catalogue metadata, so
  onboarding a curator is a data change, zero code (see
  `EARN_KNOWN_CURATOR_LABELS` in `@sdp/types`).
- **A program is one portfolio wallet pinned to one vault; an org may hold
  many.** Selecting a strategy points that wallet's stablecoin lane at a
  *single* vault — `pct: 100` for the selected strategy's lane
  (`singleStrategyAllocation`, `earn-deposit-model.ts`), which is the only
  shape the V1 API accepts: PRO-1667 caps each token group at one allocation
  entry per program. An omitted token lane keeps its current allocation, so a
  USDC pick never disturbs an existing USDT one. Concurrent exposure to several
  strategies arrives as several programs (PRO-1670): `POST /v1/earn/programs`
  creates one, `PUT /v1/earn/programs/:programId` re-targets that one in place,
  and nothing rebalances between them — moving money between programs is an
  explicit withdraw-then-deposit. Uniqueness is at the *provider wallet*:
  `earn_provider_wallets` carries a GLOBAL `UNIQUE (provider,
  provider_wallet_ref)` (migration 0056), so one provider-side wallet is claimed
  by exactly one link row platform-wide — two orgs pointing at one wallet would
  each read the other's balance. That is the only cap; the
  `(organization, environment, provider)` one that made a program singular is
  dropped. Ground has no concept of an SDP organization, one Ground account
  holds many portfolio wallets, and every SDP org shares a single account per
  environment — which is why a provider console's account-wide total will exceed
  what any one org sees in SDP.
- **Solana-only customer rails, and USDC-only on them.** Deposits are funded by
  sending **USDC** on Solana to the wallet's deposit address (`solana_devnet` in
  sandbox, `solana` in production); withdrawals settle to a Solana address the
  org controls. USDT is not a second option here: Ground routes it on Ethereum
  only (`GROUND_SOLANA_ROUTED_TOKENS`), so a USDT source never enters the
  catalogue and a USDT payout is refused before any network call. Ground can route
  capital to yield sources on other chains internally. The sync retains those
  routable sources in `earn_strategies`; customer catalogue visibility is an API
  policy, currently excluding Aave- and Morpho-related rows.
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
| `chain` | Inventory metadata. Ground may bridge Solana USDC to a source hosted elsewhere, so host chain does not prevent persistence. Customer catalogue visibility is enforced by the Earn API read route. |
| Portfolio wallet (`POST /v2/wallets`, `GET /v2/wallets/{id}`) | One SDP program: `earn_provider_wallets.provider_wallet_ref` (globally unique per provider) |
| Strategy weights | `POST /v1/earn/programs` (create) / `PUT /v1/earn/programs/:programId` (re-target) allocations → Ground target weights. **V1 is single-vault (PRO-1667): exactly one entry per token group, which the sum rule pins to `pct: 100`.** The weighted wire shape (percent, 0.1 grid, sum = 100 per group) is unchanged and the multi-entry surface is dormant — the API side of re-enabling weights is relaxing the route-schema cap (wire shape and provider contract untouched), but the dashboard separately needs weight authoring + share display back (removed by design) before the cap can safely relax. Both branches send a `requestId` — **required on create** (`EarnPortfolioWalletCreateInput.requestId`, no client-side fallback since PRO-1670: an unkeyed retry would provision a second wallet), optional on update, where the client still mints one per call. Either way SDP derives it rather than forwarding the caller's key. Ground replays a matching payload and **409s a reused key with a changed payload**, so callers must re-mint whenever the allocation changes. An omitted token lane is preserved, not cleared. |
| `depositAddresses.solana{,_devnet}` | The program's funding address (only Solana is surfaced) |
| Deposits / withdrawals / previews | `GET /v1/earn/programs/:programId/deposits`, `POST …/withdrawal-preview`, `POST …/withdrawals` (idempotent `requestId`) |

Credentials: `GROUND_SANDBOX_API_KEY` (sandbox) / `GROUND_API_KEY`
(production), injected via env (Doppler in deployed environments). With no key
present every call **fails closed** with `PROVIDER_NOT_CONFIGURED` before any
network request, and the dashboard shows a quiet "provider key not configured"
state.

## Ground portfolio wallets: keys, on-chain flow, and what SDP does not do

This is the part to understand before touching deposits or withdrawals.

### What a portfolio wallet is

One Ground portfolio wallet = one SDP Earn program (SDP stores the handle in
`earn_provider_wallets`, one link row per wallet). It is an **on-chain
custodial address** that holds both idle stablecoins and the yield-bearing
positions bought with them.
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

1. A customer sends USDC on Solana to the wallet's deposit address — an
   ordinary SPL transfer, initiated from **their** custody (Fireblocks,
   Anchorage, …). SDP builds and signs nothing. (Ground's own rails accept
   USDT too, but on Ethereum, which SDP never surfaces.)
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
domains**; USDT stays on Ethereum. That is why USDT sources never enter SDP's
catalogue at all — `GROUND_SOLANA_ROUTED_TOKENS` (client.ts) pins Ground's
Solana rails to USDC, so an un-routable source is excluded on every cluster
and withdrawal preview/create refuse un-routable tokens before any network
call. `bridge` remains a position kind because Ground may move value between the
Solana customer rail and a yield source it hosts elsewhere; host chain is not a
catalogue persistence gate.

Ground confirmed (2026-08-05) that **sandbox supports both `ethereum_sepolia`
and `solana_devnet`**; Solana flows in sandbox ride the `solana_devnet` chain
key. Both environments' keys are hard-set in `GROUND_SOLANA_CHAINS`
(providers/ground/client.ts) — the enforcement point for the Solana-only
mandate: every wallet flow sends `config.chain` from that constant, never a
caller-supplied chain. Sandbox USDT (Ground's mock Sepolia asset) stays
Sepolia-only — the withdrawal API enumerates `ethereum_sepolia` as its single
valid USDT destination — and Ground's sandbox USDT faucet
(`POST /v2/sandbox/faucets/usdt`) funds Sepolia addresses only, so exercising
the Solana lane in sandbox means devnet USDC.

**Getting devnet USDC — Circle's faucet: <https://faucet.circle.com/>.**
Select **USDC** and **Solana Devnet**, paste the recipient address, submit.
The faucet mints official devnet USDC
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) — the exact mint pinned in
the well-known-token catalogue and carried in every sandbox strategy's
`depositMints`, so what it sends is what deposits credit. Send either straight
to the program's Solana deposit address (dashboard → Fund) to watch the real
two-phase deposit, or to your own devnet wallet first when you want to
exercise the transfer yourself. The faucet rate-limits per address, so drip
ahead of time for larger test amounts.

### Withdrawals unwind in reverse — approval is policy-conditional, and we surface it

Redemption reverses the flow: vaults settle, the wallet claims stablecoin, and
Ground pays out to the destination address. Payout legs may settle at different
times, and each leg can gate on its own customer approval.

> **Resolved 2026-08-05** (previously this module's known gap). Customer-side
> Turnkey stamping is **NOT required by default**: a sandbox withdrawal on a
> wallet with no approval policy settled end to end ($5 USDT → Sepolia, wallet
> `5fe239ad…`, withdrawal `907001f5…`) while
> `GET /v2/turnkey/activities/pending` stayed empty for the entire lifecycle —
> no stamp, no vote, funds paid out.
>
> **Confirmed on the Solana lane the same day**, which is the lane SDP actually
> ships: $1 USDC from the same wallet to a devnet address, submitted through the
> dashboard (withdrawal `fd8857cf…`). Ground reserved the amount immediately
> (`withdrawableUsd` $20 → $19, `reservedUsd` $1.001004), unwound it from the
> Kamino vault while reporting `withdrawal_active`, and returned to `idle`
> ~40s later with the USDC confirmed on-chain at the destination —
> `pendingApprovals` polled `0` at every step. So neither lane requires a stamp
> by default, and the Solana path is now observed end to end rather than
> inferred from the Sepolia one. The approval flow engages only when an
> org-level approval policy is in place; Ground's docs tie that to production
> withdrawal limits (`403 withdrawal_policy_required` — *"Production
> withdrawal limit reached. Contact Ground to increase your limit."*).
>
> When a policy IS engaged, Ground parks the affected **payout leg** in
> `pending_customer_approval` while the withdrawal's top-level status keeps
> reading `processing` — the parked state is invisible to a top-level poll.
> `GroundEarnClient` therefore folds a parked leg up into the distinct
> `pending_approval` wire status, and implements the full approval surface as
> an optional capability behind `supportsWithdrawalApprovals`
> (capabilities.ts): `listPendingWithdrawalApprovals` →
> `createWithdrawalApprovalRequest` (returns the exact `stampPayload` string
> the signer must stamp — never re-serialize it) →
> `submitWithdrawalApprovalVote`. The stamp itself is produced by the
> customer-held Turnkey signer, outside Ground and outside SDP — SDP relays
> payloads and stamps, never keys. Under the shared-account model that signer
> is **account-level (platform ops), not per-SDP-org**: before production
> enablement (PRO-1635), confirm with Ground whether our production account
> carries an approval policy and who holds the signer.

Sandbox settlement timing (observed 2026-08-05): the payout leg took ~10.5
minutes against a "typical 30s" processing estimate, and the withdrawal-level
`completedAt` was stamped at plan-acceptance (~9s in), long before the leg
actually settled — read the leg/step `completedAt` for real settlement timing,
and treat the preview's estimate as indicative only.

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
                                   provider + declaredSupport + listStrategies
                                   — every member real and called) and the
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
  providers/stub.ts                StubEarnClient — every method NOT_IMPLEMENTED;
                                   a new provider starts as a ~10-line subclass.
  providers/ground/client.ts       The live Ground integration (catalogue
                                   mapping + full portfolio capability).
  providers/{veda,upshift,perena}/ Registered scaffolds awaiting integrations.

apps/sdp-api/src/
  routes/earn/                     /v1/earn HTTP surface. handlers/program.ts is
                                   the programs family (list/create/re-target,
                                   live provider reads + the withdrawal
                                   ledger); strategies is the catalogue family.
  db/migrations/postgres/0048–0056 earn_strategies (0048);
                                   earn_provider_wallets (0049, the program
                                   link); earn_program_withdrawals (0055, the
                                   withdrawal ledger — 0055 also dropped the
                                   never-written positions/movements/NAV
                                   tables, PRO-1628); 0056 lifted the
                                   one-program-per-org cap and moved uniqueness
                                   onto (provider, provider_wallet_ref),
                                   PRO-1670.
  services/earn-withdrawal-ledger.service.ts
                                   Withdrawal-ledger status machine + appliers
                                   (Hono-free; poll path today, sweep/webhooks
                                   later).
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

## Catalogue data: the sync cron vs the metrics refresh vs the dev seed

Three things write `earn_strategies`; two of them are production paths, and they
split by how fast the thing they write actually moves.

### The metrics refresh — the fast half

`apps/sdp-api/src/cron/earn-metrics-refresh.ts`

- **What it does:** for every provider implementing the optional live-metrics
  capability (`supportsLiveMetrics`), pulls the whole shelf's current figures in
  one or two calls and rewrites `current_apy` plus volatile `risk_metadata`
  (TVL, holders) on rows the catalogue already holds.
- **When it runs:** every 5 minutes (`EARN_METRICS_REFRESH_CRON`), on both
  schedulers behind the same `isEarnEnabled` gate. Unslotted on the managed job
  — that job's own five-minute schedule IS the cadence — and entered through
  `runEarnMetricsRefreshTick` so it reports to its own Sentry cron monitor.
  That monitor is the point: "the refresh silently stopped running" is this
  pass's worst failure (rates quietly go stale) and is invisible from the
  catalogue sync's monitor.
- **Ordered BEFORE the catalogue sync in the managed job**, which also protects
  the sync: `runEarnCatalogueSyncIfDue` claims its hourly Redis slot before any
  provider call, and a stall after that claim would hold the slot for its full
  TTL (~59 min). Running the unslotted half first means a provider stall happens
  before any slot exists to burn.
- **What it cannot do**, and this is the whole safety argument:
  - **Insert.** `updateStrategyMetrics` matches on
    (provider, provider_reference, environment) and no-ops otherwise, so a
    provider reporting figures for a vault the catalogue refused cannot admit
    it. Every admission gate stays in the hourly sync below. Kamino reports 173
    vaults each pass and 21 rows update — that gap is expected, not a warning.
  - **Change what a strategy IS.** Its input carries the rate and volatile
    metadata only; the metadata is MERGED, so `curator` survives.
- **Why not read live at request time:** `GET /strategies` reads exactly one
  source for the state it reports (ADR 0002, 2026-08-11 addendum), and an
  overlay would blend two. Freshness comes from cadence, so every consumer —
  API, dashboard, a partner's own cache — sees the same numbers.
- **Ground does not implement it** on purpose: its rates arrive on the same
  paged yield-sources endpoint the catalogue uses, so a five-minute pass would
  re-pay the entire catalogue cost for the rate alone. Opting in is a promise
  about cost as much as capability.

### The sync cron and the dev seed

### The sync cron — the production path

`apps/sdp-api/src/cron/earn-catalogue-sync.ts`

- **What it does:** walks every client in `EARN_PROVIDER_CLIENTS`, calls
  `listStrategies` per environment (sandbox + production), validates each row
  against the provider's declared support, and upserts on
  `(provider, provider_reference, environment)`.
- **When it runs:** hourly (`EARN_CATALOGUE_SYNC_CRON = "0 * * * *"`), on two
  schedulers behind the same flag gate (`isEarnEnabled`): in-process node-cron
  (`cron/runner.ts` — self-hosted and explicitly opted-in services) and the
  managed Cloud Run Job (`apps/sdp-api/src/job.ts`), where each five-minute
  tick claims an hourly Redis slot first (`runEarnCatalogueSyncIfDue`) so the
  effective cadence stays hourly. Completely inert in a flag-off environment
  either way.
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
- **What it seeds:** a compact five-source, Solana-hosted subset of Ground's
  sandbox catalogue, with ids/names/APYs/liquidity/curators mirroring the
  committed inventory snapshot, plus exactly one **paused** row
  (`seed-demo-kamino-superstate-usdc`) that exercises the operator-pause
  invariants — hidden from the default catalogue, unselectable as an allocation
  target, and sticky against the sync re-asserting `active`. The small seed is a
  deterministic UI convenience, not a complete mirror of the live sync.
- **It prunes its own stale rows.** Every run deletes prefixed rows the current
  fixture set no longer defines, so a re-run after the set changes cannot leave
  the old ones behind (an upsert-only seed would).
- **Fixtures are labelled, never confused with real data:** every seeded row
  carries the `seed-demo-` `provider_reference` prefix and
  `riskMetadata.seedFixture`. `--clean` deletes **only** prefixed rows, so it can
  never remove a row the live cron synced.
- **It also links one program, and that part is NOT a fixture.** The seed points
  your primary local org at one of the team's real Ground *sandbox* portfolio
  wallets, so the dashboard opens onto live provider state (real allocation, real
  forward APY, a real Solana deposit address) rather than an empty onboarding
  screen. It links exactly ONE program — a seed choice, not a cap (the API takes
  N per org since PRO-1670): the wallet it points at can be claimed by only one
  link row platform-wide, so other local orgs stay unlinked rather than being
  handed a sibling wallet that stands in for another org. If a developer has
  already attached that wallet by hand, the seed says so and stops instead of
  colliding on the global unique. The wallet is shared with teammates: funding
  it, changing its strategy through the wizard, or withdrawing from it changes
  what they see. Re-run the
  seed after your first Clerk sign-in and it moves its own link onto your real
  org; a program you created through the wizard is never moved. `--clean` removes
  the link, never the Ground wallet.
  The seeded program is an all-Solana/USDC wallet, funded via its devnet deposit
  address (Circle's faucet, above) — shared with teammates, so its balance moves
  and no particular figure is the baseline. Pointing the seed at one of the other
  funded sandbox wallets instead would surface a withdrawable balance SDP cannot
  withdraw, because those balances sit off the Solana rail while
  `balance.withdrawableUsd` reports a wallet-level total.
  Full local-dev detail: `CLAUDE.md` → "Get a program — the seed links one, the
  API allows many".
- **Commands**

  ```bash
  DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5433/sdp pnpm -C apps/sdp-api db:seed:earn
  DATABASE_URL=... pnpm -C apps/sdp-api db:seed:earn -- --clean     # remove the fixtures
  ```

  Idempotent: re-running upserts in place (ids stay stable, no duplicates).
- **When *not* to use it:** never against a shared or deployed database. If you
  have a Ground sandbox key, prefer the real cron path — and note that running
  both leaves near-twin rows in your local DB (same names, different reference
  prefix); `--clean` removes the fixtures and leaves the synced rows.

## Invariants (do not break)

1. **Money out beats money off.** The deposit-side operations (`POST /programs`
   and `PUT /programs/:programId`) gate on full provider *availability*
   (entitlement + enablement +
   credentials). Withdrawal and live-read paths gate only on *configured
   credentials*, and the withdrawal-ledger list takes no provider gate at all
   — disabling a provider must never trap funds or hide their history.
2. **Fail closed on drift.** Provider ids from the DB are open strings; all
   dispatch goes through `resolveEarnProviderClient`, which throws on unknown
   ids rather than guessing.
3. **Reads never gate on availability.** The catalogue and program snapshots
   stay readable while a provider is disabled.
4. **Declared support bounds the catalogue.** A synced strategy outside the
   provider's declared token/source envelope is rejected and logged, not
   persisted.
5. **Solana-only customer rails.** No other chain's addresses or transaction
   identifiers may leak into wire types or UI. Yield-source host chain remains
   provider metadata, and the API owns product visibility independently from
   the sync's complete persisted inventory.

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
