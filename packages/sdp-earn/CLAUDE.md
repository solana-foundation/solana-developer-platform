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
- **Sponsored vault movements** (`EARN_VAULT_FEE_SPONSORSHIP_ENABLED=true`, API
  only) additionally need a Kora to sign against: `pnpm kora:up`, then point
  `KORA_RPC_URL` at it. `infra/kora/kora.toml` already carries the Kamino program
  ids and `allow_create_account = true`, so the harness needs no edit (deployed
  devnet Kora carries the same allowlist since sdp-infra#64, asserted by the
  `Kora / Live Smoke` shard on secret-bearing CI runs). Its
  `SIGNER_PRIVATE_KEY` does need devnet SOL, because it pays the fee AND the
  share-ATA rent for real. The flag fails CLOSED, so a value
  the wrapper drops looks like "sponsorship silently did nothing" rather than an
  error — if deposits still come out `wallet-pays`, check that first.

### 3. Run it

```bash
DOPPLER_PRESERVE_ENV=DATABASE_URL,REDIS_URL,MARKETS_ENABLED,EARN_ENABLED \
  DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5433/sdp \
  REDIS_URL=redis://127.0.0.1:6380 \
  MARKETS_ENABLED=true EARN_ENABLED=true \
  pnpm dev:api:local          # API on :8787
# add EARN_VAULT_FEE_SPONSORSHIP_ENABLED to BOTH the preserve list and the
# exports above to sponsor vault movements, or put it in
# apps/sdp-api/.env.local, which run-with-config.sh overlays on top of Doppler
# and which its own comment calls the intended local override path.

DOPPLER_PRESERVE_ENV=NEXT_PUBLIC_SDP_API_BASE_URL,MARKETS_ENABLED,EARN_ENABLED \
  NEXT_PUBLIC_SDP_API_BASE_URL=http://127.0.0.1:8787 \
  MARKETS_ENABLED=true EARN_ENABLED=true \
  pnpm dev:web                # web on :3000
```

A `.claude/launch.json` (untracked) encodes both for the editor's preview
runner. Doppler supplies Clerk keys, so the dashboard needs `doppler login`.

### 4. Get catalogue data — live provider sync

With sandbox provider credentials set and both flags on, the hourly
catalogue-sync cron populates `earn_strategies` from live provider sources. It
fires on the hour, so a freshly started API has an empty catalogue until a live
pass succeeds. This is intentional: the sync is the only admitting writer and
every row must pass the provider's declared-support checks.

See README.md → "Catalogue data" for cadence and failure behaviour. A database
still holding `seed-demo-` rows from the removed `db:seed:earn` needs a one-time
clear — SQL in `docs/contributing/earn-pluggability-playbook.md` § 3.

### 4b. Get a program — create one through the API

Create programs through the dashboard or `POST /v1/earn/programs`. Since
PRO-1670 an org may hold N programs per (environment, provider), each pinned to
one vault. Migration 0056 replaced the old per-org cap with the global
`UNIQUE (provider, provider_wallet_ref)`, so a provider wallet can belong to
exactly one SDP link row.

Ground has no concept of an SDP organization: one provider account holds many
portfolio wallets, while SDP returns only the wallets linked to the current
organization. That is why the Ground console total and the SDP organization
total can legitimately differ.

Practical notes:

- Use the signed-in Clerk organization in the dashboard, or mint an API key for
  that organization's sandbox project. The `db:seed:local` development key
  belongs to the test organization and has no Earn program by default.
- Program creation uses a single-strategy allocation at 100% (the only V1 shape,
  PRO-1667). Add another strategy by creating another program.
- Fund a sandbox program by sending devnet USDC to its Solana deposit address.
  Circle's faucet (<https://faucet.circle.com/>, USDC + Solana Devnet) mints the
  official devnet USDC used by the provider flow.
- Ground enforces asset and network lanes. If a withdrawal has no quoted Solana
  USDC availability, do not substitute a wallet-level balance from another lane.

### 5. The last gate: org entitlement

Flags control *visibility*; earn access is **override-only per organization**
(`providerOverrides.earn.<provider>`). With flags on, a key set, and no override,
the UI reaches the flow and the API refuses with "requires manual activation" —
that is correct, not a bug. Grant the override in the **local** DB to proceed.

### 5b. The gate BEFORE that one: is the provider even offered?

**Kamino and Veda are the offered providers; Ground is un-surfaced. Locally the
sandbox catalogue shows Kamino's devnet shelf plus Veda's devnet Test Vault,
and there is no way to create a program — that is the shipped state, not a
broken setup** (production has no Veda rows: `VEDA_DEPLOYMENTS` is devnet-only
until Veda names a production vault, and Ground's rows are hidden everywhere).
`EARN_PROVIDER_SURFACING`
(`packages/sdp-types/src/provider-access.ts`) declares which registered
providers SDP OFFERS; it is a code constant, so there is no env var or DB row to
flip. Ground's client, credentials and catalogue sync all still run — only the
public reads and `POST /programs` refuse it.

To work on the Ground flow locally, set `ground: true` there and do not commit
it. The full rationale, the exit-safety rules it must never break, and the test
pattern are in `docs/contributing/earn-pluggability-playbook.md` §6 and ADR 0002's
2026-08-14 addendum.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Sandbox Kamino rows name devnet vaults you do not recognise | correct — they are the real devnet shelf (Allez, Steakhouse, RockawayX, Gauntlet Frontier and friends), read on-chain from `devkRng…`, not the mainnet names |
| Sandbox shows mainnet vaults, badged "Mainnet only" | correct — the PRO-1742 mirror: the Treasury strategies card's cluster toggle opted into the mirrored production shelf. Rows are browse-only (`fundable: false`); the default view stays devnet |
| Catalogue shows only Kamino rows; no Ground strategies anywhere | correct — Ground is un-surfaced (`EARN_PROVIDER_SURFACING`, §5b). The rows are still in the DB; only the reads hide them |
| No "Set up Earn"/"Add strategy"/"Change strategy" buttons; `/deposit` shows a notice | same cause: no surfaced provider can hold a program, so the custodial (program) affordances hide (§5b). The `vault_direct` deposit path is separate and unaffected |
| `POST /v1/earn/programs` → 403 "is not currently offered" | the surfacing gate, not entitlement — no `providerOverrides` lifts it (§5b) |
| Every request 500s | Redis missing/wrong port (rate limiter) |
| `/v1/earn/*` → 403 | `MARKETS_ENABLED` or `EARN_ENABLED` unset/false |
| `/dashboard/markets/embedded-yield` → 404 | same flags, web side (segment guards); legacy `/dashboard/markets/earn/*` redirects here |
| Dashboard "provider not configured" (503) | no `GROUND_SANDBOX_API_KEY` |
| "requires manual activation" | org lacks the earn provider override |
| API waits then dies on boot | `DATABASE_URL` not preserved → Doppler's Cloud SQL URL won |
| Web typecheck fails in `.next/dev/types` | stale generated cache: `rm -rf apps/sdp-web/.next/dev/types` |
| Dashboard shows empty onboarding, but a program exists in the DB | the selected Clerk organization or environment does not own that program; verify both scopes |
| `GET /v1/earn/programs` → `programs: []` with the dev API key | that key is the test org's, which has no program by design (§4b) |
| A key you minted yourself returns `strategies: []` **and** `programs: []` | the key inherited the **production** environment. An API key has no environment column — it comes from `projects.environment` (the JOIN in `middleware/auth.ts`), and every org has both a `default-sandbox` and a `default-production` project. A key on the production project sees no sandbox catalogue and no sandbox programs, which reads as "everything is missing" rather than as a scoping error. Mint against the sandbox project, and refuse anything else: a production key would drive Ground's **production** API from a laptop. |
| `POST /v1/earn/programs` → 400 "needs an idempotency key" | creation is key-REQUIRED since PRO-1670: send exactly one of body `requestId` (UUIDv4) or the `Idempotency-Key` header — never both |
| Local total ≠ Ground console total | Ground sums the whole shared account; SDP shows only the wallets your org holds (§4b) |
| Catalogue empty right after boot | sync cron runs on the hour; verify flags, provider credentials, and scheduler registration, then wait for a live pass |
| Kamino rows appear disabled in the dashboard | read the row's badge: since PRO-1692 SDP HAS a `vault_direct` deposit path (`POST /v1/earn/vault-deposits`, signed from an org custody wallet), so sandbox devnet rows are depositable once the org holds the earn override (§5). `earnVaultDepositAvailability` (sdp-web `earn-surfacing.ts`) names the gate per row; locally it is usually entitlement (§5), and production stays `environment_unavailable` until PRO-1703 lands (`VAULT_DIRECT_DEPOSIT_ENVIRONMENTS`, @sdp/types) |
| Kamino APY is blank in sandbox | correct: the metrics endpoint is mainnet's and 404s for devnet pubkeys, so `listStrategyMetrics` returns `[]` outside production and the row renders "—" rather than a fabricated rate |
| Kamino APY looks stale in production | the 5-minute metrics refresh is a separate cron — check it registered (`isEarnEnabled`), not the hourly sync |
| Local API boots on 8787 despite `PORT=…` | the dev wrapper reads **`SDP_API_PORT`**, not `PORT` (scripts/dev-local.mjs) |
| Need devnet USDC to fund a program | Circle's faucet: <https://faucet.circle.com/> — USDC + Solana Devnet (§4b) |
| No Veda rows in the PRODUCTION catalogue | correct — `VEDA_DEPLOYMENTS` (`@sdp/types/veda-programs`) is devnet-only: the published mainnet vault state is Veda's shared Test Vault, so production `listStrategies` throws `PROVIDER_NOT_CONFIGURED` and the sync skips that lane without touching other providers' rows. Sandbox carries the devnet Test Vault row |
| A Veda deposit answers 403 "is not currently offered" | stale build — `EARN_PROVIDER_SURFACING.veda` flipped `true` on 2026-08-31 (Kamino and Veda are both offered). The gate still exists and still answers this for upshift/perena/ground, and no org override lifts it (§5b) |

## Two provider shapes — read this before assuming Ground's model

Ground is **custodial**: SDP provisions an omnibus portfolio wallet, the
customer funds it, Ground spreads it across yield sources. Programs,
withdrawals and the deposit wizard all assume that shape.

Kamino and Veda are **non-custodial**: the vault is an on-chain account the
customer's own wallet deposits into, so there is no wallet for SDP to provision
or pay out from, and no address to hand out — the vault's account is a PROGRAM
account and stablecoins sent to it are destroyed.

Both implement the base `EarnVaultProvider` contract plus the **vault-direct**
capability (`EarnVaultDirectProvider`, `supportsVaultDirect`), which is
DEPOSIT + READ only. Kamino additionally implements live metrics; Veda does
not, and that is deliberate — one reading of a Veda exchange rate is not a rate
of return, so it reports no APY at all rather than a fabricated one.

Money OUT is a separate capability, `EarnVaultWithdrawProvider` /
`supportsVaultWithdraw`, which BOTH implement now — Kamino since PRO-1702 and
Veda's instant redemption since ADR 0003's "instant lands first" step, both
through `POST /v1/earn/vault-withdrawals`. Veda's QUEUED exit
(`boring_onchain_queue`) remains unimplemented: its lifecycle is settled by a
solver Veda operates and does not fit the movement model, so it waits on its
own capability and schema (`docs/decisions/0003-veda-vault-withdrawals.md` §4).

The split is not taxonomy either way: "can build a deposit" must not silently
assert "can build an exit SDP can carry" — a deposit-only provider's exit
route answers 501 until it implements this capability too. Withholding it is
never a permission gate, since ADR 0002 forbids money-out inheriting a
money-in gate, and it traps nothing — the shares sit in the organization's own
custody wallet and each provider's own surfaces can redeem them.

Neither implements ANY of the portfolio-wallet capability, so every portfolio
route answers 501 for them through `supportsPortfolioWallets`, never a
provider-id check. The two capabilities are asserted MUTUALLY EXCLUSIVE: a
client claiming both would let a portfolio route render the vault account as a
fundable address.

Money moves for both by SDP BUILDING an instruction, signing it with one of the
organization's own custody wallets and submitting it — `@sdp/kamino` and
`@sdp/veda` build the plan, the API signs and submits
(`POST /v1/earn/vault-deposits`). Since PRO-1722 the same builders also serve
the EXTERNAL-WALLET flow (`/v1/earn/external-wallet/*`), where the plan's
`owner` is a wallet SDP does not custody and the OWNER signs instead of SDP —
nothing changes on the packages' side, because the builders always took the
owner as a parameter. Those packages depend on this one, never the reverse: the
hourly catalogue cron must not load a chain SDK it never calls.

Three Kamino facts drive most of its code, all measured against the live API on
2026-08-13 (Kamino publishes an agent-readable API index at
<https://kamino.com/docs/skill.md>, and every `https://kamino.com/docs/*.md`
page it links is fetchable as raw markdown):

- **No credential.** The data API is public, which is why `publicApiDefinition`
  exists beside `keyPairCredentialDefinition` in the API's availability service,
  why `keyPairCredentialDefinition`'s parameter excludes `kamino`, and why there
  is no `KAMINO_API_KEY` in env.d.ts, turbo.json or secret-keys.mjs. Do not add
  one "for consistency" — secret-keys.mjs is "every env key the SDP API reads".
- **TWO clusters, TWO data sources.** Production reads the mainnet REST shelf;
  every other environment reads DEVNET VAULTS ON-CHAIN (`providers/kamino/devnet.ts`).
  Kamino runs a separate devnet kvault program — `devkRng…`, not mainnet's
  `KvauGM…` — carrying 21 vaults, 9 of them in the devnet USDC the Circle faucet
  dispenses, several mirroring mainnet names (Allez, Steakhouse, RockawayX,
  Gauntlet Frontier).

  This file previously asserted "mainnet only, there is no devnet deployment" as
  fact. It was wrong, and it cost a sandbox shelf where every row was permanently
  `fundable: false`. The trap: `api.kamino.finance` ignores `?env=devnet` and
  `?cluster=devnet` — both return 200 with a byte-identical mainnet payload — and
  devnet vault metrics 404. An accepted-and-ignored parameter reads exactly like
  support. Verify per-cluster program deployment on-chain, not via the API.
- **No metrics outside production.** The bulk metrics endpoint is mainnet's and
  404s for devnet pubkeys, so `listStrategyMetrics` returns `[]` there and
  sandbox rows render no rate. Computing one would mean blending devnet Klend
  reserve rates (an SDK-sized job) for a number that is ≈0 anyway.
- **The registry is permissionless**, so `GET /kvaults/vaults` is a census of
  everything ever created — 173 vaults, of which ~90 stablecoin ones are dust or
  literal test vaults (`testfail4`, `vkjm_test`). `KAMINO_MIN_TVL_USD` ($100k)
  is the admission floor; 25 vaults clear it (2026-08-31, after PYUSD joined the
  deposit set). Review a change to that number
  against `pnpm --filter @sdp/api earn:inventory:kamino`, which regenerates
  docs/earn/kamino-catalogue-inventory.md including the largest near-misses.
  Note admission is only what the SYNC stores: the strategy routes additionally
  apply the PRO-1727 curated allowlists (`routes/earn/handlers/curation.ts` in
  apps/sdp-api), so the browsable shelf is six vaults on mainnet, not 25.

  Permissionless also means **the vault NAME is attacker-controlled** — free
  text chosen by whoever called `createVaultIxs`. SDP may quote it (it is the
  strategy's name) but never PARSE it into a claim. Concretely: Kamino
  snapshots carry **no `curator`** and are **always `sourceKind: "defi"`**, and
  `declaredSupport.sourceKinds` is `["defi"]` to match. An earlier revision
  matched a curator-house list and an RWA regex against the name, which let
  anyone mint "Steakhouse USDC Prime" or "RWA USDC", clear the floor for one
  sync, and borrow a real house's name or the `sourceKind=rwa` filter. The floor
  is a cost, not an authorization. Populating either field needs verified
  authority/address data or an audited vault-address allowlist — this is the one
  place Ground's `deriveCurator` precedent does NOT transfer, because Ground's
  yield-source ids come from Ground, not from the public.

## Veda — an ALLOWLIST shelf, and currently an empty one

Veda's catalogue read is the mirror image of Kamino's. Kamino's registry is
permissionless, so its problem is filtering a census down; Veda deploys a vault
per customer under one program, so ENUMERATING that program would put other
integrators' vaults on SDP's shelf. The addresses therefore come from an
explicit allowlist — `VEDA_DEPLOYMENTS` in `@sdp/types/veda-programs` — and that
is also what makes Veda's `sourceKind` defensible: every row traces to an
address Veda named rather than to anything a stranger could create.

**SDP DOES NOT YET KNOW THOSE ADDRESSES.** `VEDA_DEPLOYMENTS` is `null` for
both clusters, so `listStrategies` throws `PROVIDER_NOT_CONFIGURED` and Veda
contributes no rows anywhere. Two candidate address sets exist and disagree: the
`declare_id!` defaults baked into each Anchor IDL inside `@vedatech/svm-sdk`,
and three different addresses in Veda's integration document. Measured
2026-08-19 against both public RPCs — none of the IDL addresses exists on either
cluster. Filling the table in is a pure data change once Veda confirms; see
`packages/sdp-veda/CLAUDE.md`.

Four things about the read itself:

- **It decodes vault state positionally**, like the Kamino devnet path, because
  this package may not load a chain SDK. Unlike Kamino's, the offsets are
  DERIVED from a published Anchor IDL and stated as a field table, and
  `@sdp/veda` — which holds the IDL — owns a test that recomputes that table and
  fails if Veda's ABI moves. A hand-maintained offset table nothing can
  contradict is how a silent ABI change becomes a wrong share mint on a
  customer's row.
- **The read is all-or-nothing, and stricter than Kamino's.** Kamino tolerates
  an odd account because it is reading a census; every Veda address is one SDP
  was GIVEN, so a missing or undecodable vault throws rather than shrinking the
  shelf.
- **The cluster is measured before anything is read.** Veda's material implies
  its devnet and mainnet deployments may share addresses. If they do, the
  genesis-hash proof is the ONLY thing between reading one chain and reporting
  the other.
- **No APY, ever, from this path.** One reading of an exchange rate is not a
  rate of return, so Veda implements no live-metrics capability rather than
  returning an empty list on every five-minute pass.

`pnpm --filter @sdp/api earn:inventory:veda` regenerates
`docs/earn/veda-catalogue-inventory.md` — what each configured vault says about
itself and what that turned into on the shelf.

## `hostCluster` — catalogued is not the same as fundable

Every `ProviderStrategySnapshot` states the cluster from which its INSTRUMENT is
reachable, and it is not implied by the environment. Ground answers with the
environment's own cluster because its deposit is Solana-side there — the row
carries that cluster's mint, and Ground bridges internally to wherever it hosts
the source (#1299 removed the old `not_solana_hosted` gate, so off-Solana
sources are indexed again; the deposit rail is what makes the cluster true, not
the host chain). Kamino answers per data source — `mainnet-beta` from the REST
shelf in production, `devnet` from the on-chain read elsewhere — and the second
is MEASURED (genesis hash) before a single vault is returned, not inferred from
the environment.

Since PRO-1742 a sandbox catalogue holds BOTH kinds of row on purpose: its own
cluster's shelf (fundable) plus a browse-only MIRROR of the production mainnet
shelf, written by the sync as two cluster-scoped lanes so each sub-shelf
converges independently (`apps/sdp-api/src/cron/earn-catalogue-sync.ts`). List
reads default to the environment's own cluster; the mirrored shelf is an
explicit `?cluster=` opt-in (the Treasury strategies card's toggle). A mirrored
row names a live mainnet vault and a mainnet mint — everything about it true,
none of it fundable from devnet — so ONE predicate decides —
`isClusterFundableInEnvironment` (src/support.ts) — and
three gates enforce its answer, none of which may re-derive the comparison:

1. `assertKnownYieldSources` in the API **calls it**, the last gate before a
   provider mutation, on both program create and re-target.
2. `mapToEarnStrategy` **calls it** to emit `hostCluster` plus a per-request
   `fundable` boolean — the machine-readable warning a partner reads.
3. `fundableStrategies` in the dashboard's deposit model **consumes that
   answer** over the wire (`strategy.fundable`). It deliberately does not
   recompute it: a browser-side copy of the cluster comparison is the second
   thing that can drift toward permissive.

Note `fundable` answers the cluster question ALONE. `true` does not promise a
deposit will succeed — a catalogue-only provider still answers 501, and the org
still needs entitlement. See the field's doc comment in `@sdp/types`.

`status` cannot express this: it is the operator's stop switch, and reusing it
would misstate the reason AND collide with the repository's refusal to overwrite
an operator pause. Migration 0057 added the column and backfilled from
`environment` (correct for every pre-existing row, all Ground's).

## Rates are refreshed on their own cadence

The catalogue sync is hourly because catalogue DRIFT is slow. Rates are not, and
an hour-old APY on a comparison table is a number a customer could act on
wrongly. So the volatile figures have a second pass —
`cron/earn-metrics-refresh.ts`, every 5 minutes — driven by the optional
`EarnLiveMetricsProvider` capability (`supportsLiveMetrics`).

Two properties keep it from fighting the sync, and both are load-bearing:

- **It can only UPDATE.** `updateStrategyMetrics` matches on (provider,
  reference, environment) and no-ops otherwise, so a provider reporting figures
  for a vault the catalogue refused cannot admit it. Every admission gate stays
  in the hourly sync. Kamino deliberately reports its whole shelf (173 rows) and
  21 land.
- **It cannot change what a strategy IS.** `UpdateEarnStrategyMetricsInput`
  carries the rate and volatile risk metadata only, and the metadata is MERGED
  so `curator` (which the sync derives) survives.

**A provider's shelf read must be ALL-OR-NOTHING.** `_loadMetricsByVault`
throws rather than returning a short map — on a page missing its `result` array
and on hitting the pagination cap with a live token. This is not defensive
padding: a vault with no metrics row is dropped as `no_metrics`, and the sync
DELETES rows a provider no longer lists, so a half-read shelf would not degrade
gracefully — it would delist every vault whose page went unread, in both
environments. Failing the read makes the sync skip the pass and leave the
catalogue intact. Any future provider whose catalogue read is paginated owes the
same guarantee; `providerFetchJson` does no schema validation, so a 200 carrying
`{}` is otherwise indistinguishable from an empty page.

It refreshes into the DB rather than reading live at request time because the
strategies route reads exactly ONE source for the state it reports (ADR 0002
addendum). Freshness is cadence, not blending. A provider needing one request
per vault should NOT implement the capability — Ground does not, because its
rates come from the same paged endpoint the catalogue uses.

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
- Optional capabilities so far: portfolio wallets, withdrawal approvals, live
  metrics, vault-direct (deposit + read) and vault-withdraw. All are
  method-presence guards in capabilities.ts and a provider may implement any
  subset — Kamino has live metrics, vault-direct and vault-withdraw
  (PRO-1702); Veda has vault-direct and vault-withdraw (instant redemption
  only — the queued exit waits on its own capability, see
  `docs/decisions/0003-veda-vault-withdrawals.md`). A deposit-only provider's
  exit route answers 501, which is a statement about SDP's plumbing rather
  than about anyone's right to their money.
- **`sponsoredPrograms(cluster)` is a REQUIRED member of
  `EarnVaultDirectProvider`, not an optional capability** (PRO-1736). It returns
  every program the client may emit an instruction for, as plain base58 strings,
  so a paymaster allowlist in another repository can be asserted a superset of it.
  Consequence worth knowing before you add a provider: a client that implements
  `buildVaultDeposit` and `readVaultPositions` but omits this one answers FALSE
  to `supportsVaultDirect`, and its deposit route returns 501. That is deliberate.
  A client that cannot say which programs it touches cannot be sponsored safely,
  and failing loudly beats executing unsponsored by surprise.

## Hard invariants (ADR 0002)

- **Money out beats money off**: nothing in this package may make withdrawals
  depend on availability/enablement — only on configured credentials.
- Catalogue mapping must exclude anything that would trap funds (Ground:
  `mode === "buy_only"` sources are skipped, only `active` is listed).
- **Persistence and visibility are separate.** `distillGroundYieldSource`
  indexes every active source Ground can fund and exit through SDP's Solana USDC
  rail, regardless of the source's host chain. The catalogue sync deletes only
  rows Ground no longer lists or that stop satisfying those safety gates. The
  Earn strategy API separately hides Aave- and Morpho-related rows from list and
  detail reads; do not move that product policy into this provider client.
- Missing API key ⇒ throw `PROVIDER_NOT_CONFIGURED` **before** any network call.

## Conventions

- New provider = subclass `providers/stub.ts` (`StubEarnClient`), register in
  `EARN_PROVIDER_CLIENTS`, add the `./providers/<id>/client` package export.
  A registry-consistency test in src/index.test.ts fails if any of these is
  missing for an id in `EARN_PROVIDERS`.
- All HTTP goes through `providerFetch`/`providerFetchJson` (src/fetch.ts) —
  never raw `fetch` in a client.
- **`error` on a failure body is read as BOTH an object and a bare string**
  (`extractProviderErrorMessage`). Measured 2026-08-14: Ground rejects a request
  with `{"error":"Invalid query params: unknown parameter(s)","code":
  "unknown_parameters",…}` — `error` is a STRING. Reading only `error.message`
  made every Ground 4xx fall back to `"<provider> request failed with status
  <n>"`, which names the status and explains nothing, so a refused write reached
  the dashboard with its reason stripped. Do not narrow these shapes again; the
  provider's own sentence is the most useful thing on this path. It picks the
  first NON-BLANK of `error` / `message` / `reason` — the first *present* one
  would let `error: ""` beside a real `message` select the blank and fall back,
  discarding an explanation the body did carry.
- **Chain keys are HARD-SET in `GROUND_SOLANA_CHAINS`**
  (providers/ground/client.ts): sandbox = `solana_devnet`, production =
  `solana`. Ground confirmed (2026-08-05) sandbox supports both Ethereum
  Sepolia and Solana devnet — Solana flows in sandbox use the `solana_devnet`
  key. Every wallet flow sends `config.chain` from the constant; no SDP flow
  may ever take a caller-supplied chain. SDP only cares about Solana. Sandbox
  mock USDT and Ground's sandbox faucet (`POST /v2/sandbox/faucets/usdt`) are
  Sepolia-only, so exercising the Solana lane locally means devnet USDC to the
  wallet's deposit address (§4b).
- **The withdrawal preview takes an OPTIONAL amount** (PRO-1675).
  `EarnPortfolioWithdrawalPreviewInput.amountUsd` may be omitted to ask the
  liquidity question; a provider client must then OMIT the field from its wire
  call, never send `null` or `0`. Two Ground sandbox behaviours were measured on
  2026-08-13 and **neither matches its published contract** — do not "fix" them
  without re-measuring:
  1. The docs say omitting `amountUsd` returns the maximum withdrawable. Sandbox
     instead answers **409** — but carries the lane's `balance` breakdown, so
     the number still arrives, on the error path. That is why
     `groundWithdrawalLiquidityDetails` lifts it onto `SdpEarnError.details` and
     why the dashboard treats a 409-with-balance as a resolved read rather than
     a failure.
  2. `withdrawableUsd` is a **balance, not a fillable amount**. A lane reporting
     `20.001241` answers 200 for `20.00` and **409 for `20.001241` itself**.
     Anything offering a one-click max must floor to whole cents; the dashboard
     does (`floorUsdToCents`) while still permitting a hand-typed larger amount.
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
  `earn:inventory:render` only re-formats the committed JSON (outcomes are baked
  into the snapshot) — after changing a distillation gate you must re-`fetch`, not
  re-render. If `doppler run` fails for want of a project scope, the fetch also
  works from `apps/sdp-api/.env.local`:
  `cd apps/sdp-api && set -a && . ./.env.local && set +a && npx tsx scripts/inventory-ground-catalogue.ts fetch`.
  NOTE: `deriveCurator` and `GROUND_CURATOR_HOUSES` still carry EVM vocabulary
  (e.g. `morpho`) on purpose — they parse Ground's RAW 18-source response so the
  inventory can attribute what we DROP. Do not "clean" those.

## Registered is not the same as offered

`EARN_PROVIDERS` is what this deployment can talk to; `EARN_PROVIDER_SURFACING`
(both in `packages/sdp-types/src/provider-access.ts`) is what SDP sells today.
An un-surfaced provider keeps everything in this package — client, credentials,
catalogue sync, metrics refresh — and disappears from `GET /strategies` and
`POST /programs` only.

**Nothing in this package reads it, and nothing should.** Surfacing is a product
policy enforced at the API's read/write boundary, exactly like
`HIDDEN_STRATEGY_TERMS`; a client here gates on credentials alone, the same rule
that keeps feature flags out of this package. Keeping the sync provider-blind is
what makes the DB a truthful inventory and re-surfacing a deploy rather than an
hour's wait.

The invariant it must never break is the one at the top of "Hard invariants":
surfacing gates the way IN (a NEW program) and nothing else, so it can never
trap funds. §6 of `docs/contributing/earn-pluggability-playbook.md` is the
checklist.

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
