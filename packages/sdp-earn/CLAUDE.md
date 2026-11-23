# @sdp/earn — agent notes

Provider-integration layer for SDP Earn, **and the canonical local-dev runbook
for the whole Earn stack** (API + web + DB + provider). The design is
multi-provider — keep every provider-specific detail behind the provider-neutral
seams below. Read `README.md` here for the full architecture (including the
custody boundary); ADR 0002 (`docs/decisions/`) for the invariants.

## Hosted API access

This package defines provider capabilities; the API router defines caller
authentication. Do not confuse a provider's own upstream credential with an
integrator's SDP API key.

- Every Earn route, catalogue reads and preparation included, requires an
  authenticated SDP credential with its Earn permission, and runs in that
  credential's project environment.
- Missing credentials for a provider that requires them are a provider
  configuration failure. They say nothing about whether an integrator supplied
  an SDP API key.

Earn guides live in `apps/sdp-docs/content/docs/earn` and
`apps/sdp-docs/content/docs/guides/embedded-yield.mdx`. The normal docs generators render the
public contract for the deployment's release channel. Earn and its shared
operation routes follow the existing module tags and channel rules; do not add
a rewrite-specific visibility flag. Programs and provider-action routes are
removed. The core contract is
documented in `apps/sdp-docs/content/docs/earn/integration-details.mdx`.

## Local development — the whole Earn stack

**Absolute rule: local resources only.** Never point any of this at a shared or
production database, and never exercise a provider's production API from a
laptop — sandbox base URL + `*_SANDBOX_API_KEY` only. Note that dashboard
sessions resolve their environment from the `x-project-id` project (the
project middleware's cluster scope), so selecting an org's **production** project —
possible via curl even while the dashboard's switcher stays locked — drives the
provider's production API. Locally, only ever use sandbox projects and never
set a production `*_API_KEY`.

A mainnet vault-direct readiness run is the narrow exception to the provider
API half of that rule, not the infrastructure half. Keep Postgres and Redis
local, use disposable funded wallets, and limit the run to public on-chain and
market-data surfaces. Do not load custodial provider production credentials.
Use an isolated local production project/key with `ENVIRONMENT=production` and
a genesis-verified mainnet RPC. Keep Kora off unless Kora itself is the test;
an external caller-provided fee payer is not Kora sponsorship.

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

- **Module gate**: the release channel decides Earn; the local `experimental`
  channel runs it. Under the Doppler wrapper, plain shell exports are ignored
  unless named in `DOPPLER_PRESERVE_ENV`.
- **Environment** comes from the credential's project: an API key's, or the
  dashboard session's selected project.
- **Sponsored vault movements** (`EARN_VAULT_FEE_SPONSORSHIP_ENABLED=true`, API
  only) additionally need a Kora to sign against: `pnpm kora:local:up`, which
  hands the API `KORA_DEVNET_URL` via `.secrets/kora-local/api.env`. `infra/kora/kora.toml` already carries the Kamino program
  ids, every devnet Earn deposit mint in `allowed_tokens` (wSOL first) and
  `allow_create_account = true`, so the harness needs no edit (deployed devnet
  Kora carries the same allowlist and token set since sdp-infra#64 and
  PRO-1962, asserted by the `Kora / Live Smoke` shard on secret-bearing CI
  runs). The harness image (e9bc391) has no `transfer_hook_policy`; the
  deployed f0377c0 configs set it to `allow_all` so sign-only PYUSD/USDG
  movements pass, see the comment in the toml before bumping the image. Its
  `SIGNER_PRIVATE_KEY` does need devnet SOL, because it pays the fee AND the
  share-ATA rent for real. The flag fails CLOSED, so a value
  the wrapper drops looks like "sponsorship silently did nothing" rather than an
  error — if deposits still come out `wallet-pays`, check that first.

### 3. Run it

```bash
DOPPLER_PRESERVE_ENV=DATABASE_URL,REDIS_URL \
  DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5433/sdp \
  REDIS_URL=redis://127.0.0.1:6380 \
  pnpm dev:api          # API on :8787
# add EARN_VAULT_FEE_SPONSORSHIP_ENABLED to BOTH the preserve list and the
# exports above to sponsor vault movements, or put it in
# apps/sdp-api/.env.local, which run-with-config.sh overlays on top of Doppler
# and which its own comment calls the intended local override path.

DOPPLER_PRESERVE_ENV=NEXT_PUBLIC_SDP_API_BASE_URL \
  NEXT_PUBLIC_SDP_API_BASE_URL=http://127.0.0.1:8787 \
  pnpm dev:web                # web on :3000
```

A `.claude/launch.json` (untracked) encodes both for the editor's preview
runner. Doppler supplies Clerk keys, so the dashboard needs `doppler login`.

### 4. Get catalogue data — live provider sync

With sandbox provider credentials set, the catalogue-sync
cron populates `earn_strategies` from live provider sources. It runs once when
the cron service starts (`pnpm dev`'s `dev:worker`; through the slotted
`runEarnCatalogueSyncIfDue`, so restarts inside the hour skip) and then on the
hour, so a freshly started stack lists strategies within seconds of coming up. The sync is the only admitting writer and every
row must pass the provider's declared-support checks.

See README.md → "Catalogue data" for cadence and failure behaviour. A database
still holding `seed-demo-` rows from the removed `db:seed:earn` needs a one-time
clear — SQL in `docs/contributing/earn-pluggability-playbook.md` § 3.

### 4b. Prepare a strategy action

Treasury and Embedded Yield use the same five core routes:
`GET /v1/earn/discovery`, `GET /v1/earn/positions`,
`GET /v1/earn/positions/{positionId}`, `POST /v1/earn/deposit` and
`POST /v1/earn/withdraw`. Catalogue items are **strategies**, identified by
`strategyId`; a strategy may represent a vault, a token or an RWA product.
Provider interfaces keep protocol-specific names such as `EarnVaultProvider`.

API users normally have an SDP API key and their own Solana wallet, without any
wallet registered in SDP. Lead examples with `source: { ownerAddress }`.
Preparation returns unsigned transaction bytes; the caller signs through any
compatible wallet integration and submits base64 `signedTransaction` with the
reviewed action ID/version and an `Idempotency-Key`. Every required signature
must match the prepared owner, fee payer and unchanged message. Submit returns
`202`; the worker broadcasts those exact bytes. Withdrawals derive the same
owner from the position ID, without requiring a custody-wallet record.

An existing connected wallet's `source: { walletId }` is an optional convenience.
It uses the same preparation and `/v1/operations/{operationId}/submit` routes,
with signing delegated to that wallet's configured provider instead of caller
signed bytes. Poll the same operation to recover after reload or a lost response.

Use `awaiting_signature` for pending signing and `sign_in_provider` for provider
instructions such as "Sign in Fireblocks". Custody adapters retain their own
proposal and approval policy internally. Earn exposes no separate approval
endpoint or status, and provider-side signing needs no second submit call.

Submit authorizes only that exact reviewed transaction. Withdrawal selection
uses `nextAction: select_option` and `terms.options`; refresh takes the current
`actionId`, `version` and advertised `optionId` to prepare a new review.
Later refreshes omit `optionId` and retain the selected route. If it is
unavailable, fail instead of choosing another route.
Refresh is preparation-only and requires safe replacement before any submit
acceptance. Once accepted, refresh and cancellation return `409 CONFLICT`;
track the original outcome. Definitive signing rejection or proven nonexecution
is terminal `failed`. A retry then starts a new deposit/withdrawal request with
a new idempotency key. Timeout, provider uncertainty and absent RPC history
never justify another operation or post-submit refresh.

`canCancel` is the authoritative state capability, not a route permission.
It is false after any accepted submit in the operation's history and while an
exposed owner transaction outcome is unknown. Consumers
must not infer cancellation from status or wallet kind. Public `/cancel`
abandons only safe preparation. Provider signing cleanup for permission loss
or expiry remains private worker safety; there is no public queued-withdrawal
cancellation after submit.

Compose funding swaps and deposits in one atomic transaction, sized to the
swap's guaranteed minimum output. Retry oversized compositions with a compact
route, then refuse before persisting a build. Do not return a standalone funding
swap, a deposit continuation or a separate claim API.

The old catalogue, program, preview, build and submission HTTP routes are
removed. Current holdings and obligations use the core routes and shared operations. There are no compatibility HTTP routes or retirement stubs.

### 5. The last gate: org entitlement

Flags control _visibility_; earn access is **override-only per organization**
(`providerOverrides.earn.<provider>`). With a key set and no override,
the UI reaches the flow and the API refuses with "requires manual activation" —
that is correct, not a bug. Grant the override in the **local** DB to proceed.

### 5b. The gate BEFORE that one: is the provider even offered?

**Kamino, Veda, Jupiter Lend, and Ondo are offered. WisdomTree is registered
pre-launch; Upshift and Perena remain stubs.** The sandbox catalogue's own lane
shows Kamino's devnet shelf plus Veda's devnet Test Vault. Its explicit mainnet
mirror can also show browse-only Jupiter Lend and Ondo rows. Production offers
Veda's USDC PRIME and OUSD PRIME vaults from `VEDA_DEPLOYMENTS`. The Ground
integration that previously served the custodial program flow
was removed, so no registered provider is portfolio-capable today. The unsupported program HTTP surface is removed.
`EARN_PROVIDER_SURFACING`
(`packages/sdp-types/src/provider-access.ts`) declares which registered
providers SDP OFFERS; it is a code constant, so there is no env var or DB row to
flip. The full rationale, the exit-safety rules it must never break, and the
test pattern are in `docs/contributing/earn-pluggability-playbook.md` §6 and
ADR 0002's 2026-08-14 addendum.

### Troubleshooting

| Symptom                                                                                                         | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox Kamino rows name devnet vaults you do not recognise                                                     | correct — they are the real devnet shelf (Allez, Steakhouse, RockawayX, Gauntlet Frontier and friends), read on-chain from `devkRng…`, not the mainnet names                                                                                                                                                                                                                                                                                                          |
| Sandbox shows mainnet strategies, badged "Mainnet only"                                                         | The production mirror is browse-only (`fundable: false`); a sandbox deposit must use its own cluster.                                                                                                                                                                                                                                                                                                                                                                 |
| Program creation and allocation HTTP routes are removed                                                         | Those writers are retired. Prepare strategy actions through the core Earn routes (§4b).                                                                                                                                                                                                                                                                                                                                                                               |
| Every request 500s                                                                                              | Redis missing/wrong port (rate limiter)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/v1/earn/*` → 403                                                                                              | the release channel does not run Earn (`stable`)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/dashboard/markets/embedded-yield` → 404                                                                       | same channel, web side (segment guards); legacy `/dashboard/markets/earn/*` redirects here                                                                                                                                                                                                                                                                                                                                                                            |
| Dashboard "provider not configured" (503)                                                                       | the named provider has no credentials in this environment                                                                                                                                                                                                                                                                                                                                                                                                             |
| "requires manual activation"                                                                                    | org lacks the earn provider override                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| API waits then dies on boot                                                                                     | `DATABASE_URL` not preserved → Doppler's Cloud SQL URL won                                                                                                                                                                                                                                                                                                                                                                                                            |
| Web typecheck fails in `.next/dev/types`                                                                        | stale generated cache: `rm -rf apps/sdp-web/.next/dev/types`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Discovery returns `strategies: []` unexpectedly                                                                 | Check the credential's project environment and the requested `cluster`; local calls must use a sandbox project.                                                                                                                                                                                                                                                                                                                                                       |
| Catalogue empty right after boot                                                                                | the sync runs on cron service start and then once per hourly slot; verify the release channel, provider credentials, and scheduler registration, then wait for a live pass                                                                                                                                                                                                                                                                                            |
| A discovered strategy cannot accept a deposit                                                                   | Check `capabilities.deposit` and its unavailable reason. Preparation also checks cluster, provider availability, active status and entitlement.                                                                                                                                                                                                                                                                                                                       |
| Kamino APY is blank in sandbox                                                                                  | correct: the metrics endpoint is mainnet's and 404s for devnet pubkeys, so `listStrategyMetrics` returns `[]` outside production and the row renders "—" rather than a fabricated rate                                                                                                                                                                                                                                                                                |
| Kamino APY looks stale in production                                                                            | the 5-minute metrics refresh is a separate cron — check it registered (`isEarnEnabled`), not the hourly sync                                                                                                                                                                                                                                                                                                                                                          |
| Local API boots on 8787 despite `PORT=…`                                                                        | the dev wrapper reads **`SDP_API_PORT`**, not `PORT` (apps/sdp-api/scripts/lib/dev-env.mjs)                                                                                                                                                                                                                                                                                                                                                                           |
| Need devnet USDC to fund a program                                                                              | Circle's faucet: <https://faucet.circle.com/> — USDC + Solana Devnet (§4b)                                                                                                                                                                                                                                                                                                                                                                                            |
| No Veda rows in the PRODUCTION catalogue                                                                        | the production sync needs a mainnet RPC: with no `SOLANA_RPC_<PROVIDER>_MAINNET_API_KEY_URL`, production `listStrategies` throws `PROVIDER_NOT_CONFIGURED` and the sync skips that lane without touching other providers' rows. With one, the catalogue carries the two PRIME vault rows from `VEDA_DEPLOYMENTS` (`@sdp/types/veda-programs`). Sandbox carries the devnet Test Vault row                                                                              |
| A Veda deposit answers 403 "is not currently offered"                                                           | stale build — `EARN_PROVIDER_SURFACING.veda` flipped `true` on 2026-08-31 (Kamino, Veda, Jupiter Lend and Ondo are offered). The gate still exists and still answers this for upshift/perena, and no org override lifts it (§5b)                                                                                                                                                                                                                                      |
| No Ondo rows in the sandbox catalogue's own lane; USDY only appears under the mainnet-mirror toggle             | correct — Ondo has no devnet deployment anywhere (even its staging runs on mainnet), so sandbox carries USDY only as the PRO-1742 browse-only mirror row. See the Ondo section below                                                                                                                                                                                                                                                                                  |
| The Ondo pass fails with `Ondo assets API listed no usdy entry` or `Ondo USDY apy is not a non-negative number` | `ondo.finance/api/v1/assets` changed shape (the `usdy` entry or its numeric `apy` percent). Check the live body; the row keeps its last figures until fixed                                                                                                                                                                                                                                                                                                           |
| No Ondo row in the sandbox MIRROR either, on a deployment with no mainnet RPC                                   | the production pass needs a mainnet RPC: the catalogue sync hands every on-chain read the preferred endpoint of the requested cluster's managed pool (`ctx.catalogueRpcUrl`, read by `resolveCatalogueRpcUrl`), with no process-default fallback. With no `SOLANA_RPC_<PROVIDER>_MAINNET_API_KEY_URL` the pass is a steady-state skip and the mirror converges to empty. Managed deployments refuse to boot without both pools; a local or self-hosted stack sets one |

## Ondo — a TOKEN-HOLDING strategy, no vault program at all

Registered 2026-09-02 (PRO-1803), surfaced 2026-09-14 (PRO-1832). USDY is a
plain SPL token whose price accrues Treasury yield, so the strategy is HOLDING
it: deposit =
Jupiter-routed USDC→USDY swap, position = the owner's USDY balance, exit = the
reverse swap. Mainnet-only — Ondo has NO devnet deployment (verified on-chain;
even their staging environment runs on mainnet with different mints), so the
sandbox shelf carries the row only through the PRO-1742 browse-only mirror.
The catalogue read (`providers/ondo/client.ts`) genesis-proves the RPC and
verifies the mint account, including its initialized flag, before reporting
the one-row shelf, and the row is
its `sourceKind: "rwa"`: the classification traces to the
issuer's own published mint address in `ONDO_DEPLOYMENTS`
(`@sdp/types/ondo-programs`), the same allowlist bar Veda clears. Its
`currentApy` and Solana `tvlUsd` are the issuer's published figures, one
keyless GET to `ondo.finance/api/v1/assets` (`providers/ondo/usdy-rate.ts`,
PRO-1833; NOT the credentialed Stocks API, which has no USDY). Written by this
hourly pass, not the metrics refresh, because Ondo sets the rate monthly. An
unreachable API fails the Ondo pass (rows keep their last figures).
Percent-to-fraction conversion preserves the API number's decimal digits,
including exponent notation, and truncates to six places using integer
arithmetic. Do not round with `toFixed` before truncating the rate.
The row's `riskMetadata` carries the eligibility constraints an
integrator asks about (Ondo's prohibited and qualified-investor-only
jurisdictions, issuer freeze authority), with the longer record in
`docs/earn/ondo-catalogue-inventory.md`. The `eligibility` string names the US
and Canada and links Ondo's eligibility page for the rest; re-read that page
before changing the string or the inventory doc, and never shrink it back to
"non-US persons only".
Execution lives in `@sdp/ondo`; see that package's CLAUDE.md for why the
primary mint/redeem facility is deliberately unused (Ondo onboarding, no Solana
entry point) and how the Jupiter trust boundary stays single-owner in the API.

## Provider execution capabilities

The core API supports per-strategy actions. Program creation, automated
allocation and portfolio-wallet adapter contracts are removed. Add only
capabilities used by a current strategy and the shared operation lifecycle.

Every current executing provider is **non-custodial** and implements the base
`EarnVaultProvider` contract plus the **vault-direct** capability
(`EarnVaultDirectProvider`, `supportsVaultDirect`). Kamino and Veda target
on-chain vault programs. Jupiter Lend targets its pinned market. Ondo swaps into
the yield-bearing USDY token. Pre-launch WisdomTree sends an eligibility-checked
primary-market order leg. None exposes a generic deposit address as a safe
substitute for the provider-built transaction. Kamino additionally implements
live metrics; Veda does not, because one exchange-rate reading is not a rate of
return.

Money OUT is a separate capability, `EarnVaultWithdrawProvider` /
`supportsVaultWithdraw`. Every surfaced executing provider implements a direct
exit; WisdomTree's pre-launch client implements its provider-order redemption.
Veda's QUEUED exit
(`boring_onchain_queue`) is a separate `EarnVaultQueuedWithdrawProvider`
capability because landing its holder-signed request only escrows shares. Its
request, optional solver fulfillment, and post-deadline cancellation live in a
dedicated durable request model rather than pretending the request transaction
paid assets. SDP observes provider lifecycle events to distinguish fulfillment
from cancellation after the request PDA closes; it never acts as Veda's solver
or silently substitutes the queue for an instant exit. See
`docs/decisions/0003-veda-vault-withdrawals.md` §4.

The split is not taxonomy either way: "can build a deposit" must not silently
assert "can build an exit SDP can carry" — a deposit-only provider's exit
route answers 501 until it implements this capability too. Withholding it is
never a permission gate, since ADR 0002 forbids money-out inheriting a
money-in gate, and it traps nothing — the shares sit in the organization's own
custody wallet and each provider's own surfaces can redeem them.

Money moves through provider-specific execution packages: `@sdp/kamino`,
`@sdp/veda`, `@sdp/jupiter-lend`, `@sdp/ondo`, `@sdp/hastra`, and pre-launch
`@sdp/wisdomtree`. The core API prepares one operation for either owner model.
For custody, the worker uses the organization's configured signer and tracks
its provider's signing process before broadcast. For an owner address, the
caller signs the exact prepared transaction and submit queues those bytes for
the worker.
Both use the same builders, which take the owner as a parameter and never sign.
Those packages depend on this one, never the reverse: the hourly catalogue cron
must not load a chain SDK it never calls.

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
- **The shelf quotes the TRAILING 7d rate, never the spot rate.** The metrics
  row carries both: `apy` is the instantaneous blended rate and tracks Klend
  reserve utilization minute to minute, `apy7d` is the trailing week. On
  2026-09-10 the Main Market USDC reserve hit ~97% utilization and `apy` read
  18-23% on six USDC vaults whose `apy7d` sat at 3-7%, which fired the
  PRO-1867 anomaly alert 15 times on a number that was true for the hour and
  useless as a yield quote. So `currentApy` is `apy7d` at both call sites
  (`distillKaminoVault` and `listStrategyMetrics`), the spot figure rides along
  as `riskMetadata.spotApy` for a future "current" column, and a missing
  `apy7d` is "no rate", not a fallback to `apy` (PRO-1922). Kamino's own vault
  page headline is a trailing figure too; do not quote hotter than the provider.
- **The registry is permissionless**, so `GET /kvaults/vaults` is a census of
  everything ever created — 173 vaults, of which ~90 stablecoin ones are dust or
  literal test vaults (`testfail4`, `vkjm_test`). `KAMINO_MIN_TVL_USD` ($100k)
  is the admission floor; 25 vaults clear it (2026-08-31, after PYUSD joined the
  deposit set). Review a change to that number
  against `pnpm --filter @sdp/api earn:inventory:kamino`, which regenerates
  docs/earn/kamino-catalogue-inventory.md including the largest near-misses.
  Sync admission determines the indexed catalogue. Legacy strategy reads and
  core deposit admission additionally apply the reviewed execution allowlists
  (`routes/earn/handlers/curation.ts` in apps/sdp-api). Core discovery includes
  indexed rows outside that shelf with deposits marked `catalogue_only`; a
  broader discovery result never widens execution admission.

  Permissionless also means **the vault NAME is attacker-controlled** — free
  text chosen by whoever called `createVaultIxs`. SDP may quote it (it is the
  strategy's name) but never PARSE it into a claim. Concretely: Kamino
  snapshots carry **no `curator`** and are **always `sourceKind: "defi"`**, and
  `declaredSupport.sourceKinds` is `["defi"]` to match. An earlier revision
  matched a curator-house list and an RWA regex against the name, which let
  anyone mint "Steakhouse USDC Prime" or "RWA USDC", clear the floor for one
  sync, and borrow a real house's name or the `sourceKind=rwa` filter. The floor
  is a cost, not an authorization. Populating either field needs verified
  authority/address data or an audited vault-address allowlist — free-text
  vault names must never feed a curator or source-kind classification.

## Veda: an allowlisted shelf

Veda's catalogue read is the mirror image of Kamino's. Kamino's registry is
permissionless, so its problem is filtering a census down; Veda deploys a vault
per customer under one program, so ENUMERATING that program would put other
integrators' vaults on SDP's shelf. The addresses therefore come from an
explicit allowlist — `VEDA_DEPLOYMENTS` in `@sdp/types/veda-programs` — and that
is also what makes Veda's `sourceKind` defensible: every row traces to an
address Veda named rather than to anything a stranger could create.

`VEDA_DEPLOYMENTS.devnet` pins Veda's confirmed Test Vault programs and vault
state, measured on chain. `VEDA_DEPLOYMENTS["mainnet-beta"]` pins the USDC
PRIME (id 4) and OUSD PRIME (id 5) vaults Veda supplied for SDP (PRO-1777), each
pinned to one asset in `VEDA_MAINNET_VAULTS`. Sandbox therefore carries one
fundable Veda row and production two. See `packages/sdp-veda/CLAUDE.md` for the
measured addresses and execution notes.

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
reachable, and it is not implied by the environment. Kamino answers per data
source — `mainnet-beta` from the REST shelf in production, `devnet` from the
on-chain read elsewhere — and the second is MEASURED (genesis hash) before a
single vault is returned, not inferred from the environment.

Since PRO-1742 a sandbox catalogue holds BOTH kinds of row on purpose: its own
cluster's shelf (fundable) plus a browse-only MIRROR of the production mainnet
shelf, written by the sync as two cluster-scoped lanes so each sub-shelf
converges independently (`apps/sdp-api/src/cron/earn-catalogue-sync.ts`). List
reads default to the environment's own cluster; the mirrored shelf is an
explicit `?cluster=` opt-in. A mirrored row names a live mainnet strategy and
mint, but cannot receive devnet funds. `isClusterFundableInEnvironment`
(src/support.ts) owns that comparison. `mapToEarnStrategy` calls it to emit
the per-request `fundable` field, which clients consume. The core deposit
admission path calls it through `assertStrategyDepositable`, both when
preparing and before requesting a custody signature. Never re-derive the
comparison in a client or provider adapter.

Note `fundable` answers the cluster question ALONE. `true` does not promise a
deposit will succeed: the matching execution capability, money-in environment,
active strategy, and organization entitlement must still pass. See the field's
doc comment in `@sdp/types`.

`status` cannot express this: it is the operator's stop switch, and reusing it
would misstate the reason AND collide with the repository's refusal to overwrite
an operator pause. Migration 0057 added the column and backfilled from
`environment`.

## Rates are refreshed on their own cadence

The catalogue sync is hourly because catalogue DRIFT is slow. Rates are not, and
an hour-old APY on a comparison table is a number a customer could act on
wrongly. So the volatile figures have a second pass —
`cron/earn-metrics-refresh.ts`, every 5 minutes — driven by the optional
`EarnLiveMetricsProvider` capability (`supportsLiveMetrics`).

Two properties keep it from fighting the sync, and both are load-bearing:

- **It can only UPDATE.** The normal path sends one atomic
  `updateStrategyMetricsBatch` per provider/environment; it matches on
  (provider, reference, environment) and no-ops otherwise, so a provider
  reporting figures for a vault the catalogue refused cannot admit it. A failed
  batch falls back to `updateStrategyMetrics` per row to isolate malformed data
  without costing the rest of the shelf its refresh. Every admission gate stays
  in the hourly sync. Kamino deliberately reports its whole shelf (173 rows) and
  only catalogued rows land.
- **It cannot change what a strategy IS.** `UpdateEarnStrategyMetricsInput`
  carries rate observations and volatile risk metadata only. Metadata is
  merged so `curator` (which the sync derives) survives.

`ProviderStrategySnapshot.rateObservedAt` records when SDP observed the
provider-reported APY. The catalogue pass stamps a rate when its snapshot has
no observation time, and mirrors preserve the same timestamp. The metrics
pass stamps its own successful observations; a missing rate clears its time.
Core discovery exposes this as `rate.observedAt`, which remains null for an
unknown observation. Never substitute a row's unrelated `updated_at`.

**A provider's shelf read must be ALL-OR-NOTHING.** `_loadMetricsByVault`
throws rather than returning a short map — on a page missing its `result` array
and on hitting the pagination cap with a live token. This is not defensive
padding: a vault with no metrics row is dropped as `no_metrics`, and the sync
deprecates strategies a provider no longer lists, so a half-read shelf would
delist every strategy whose page went unread, in both environments. The row
and its exit metadata remain available for existing holdings. Failing the read
makes the sync skip the pass and leave the catalogue intact. Any future
provider whose catalogue read is paginated owes the
same guarantee; `providerFetchJson` does no schema validation, so a 200 carrying
`{}` is otherwise indistinguishable from an empty page.

It refreshes into the DB rather than reading live at request time because the
strategies route reads exactly ONE source for the state it reports (ADR 0002
addendum). Freshness is cadence, not blending. A provider whose rates come from
the same paged endpoint its catalogue uses should NOT implement the capability —
the five-minute pass would re-pay the whole catalogue cost for the rate alone.

## Contracts

- `EarnVaultProvider` (src/types.ts) is the base catalogue contract:
  `provider` + `declaredSupport` + `listStrategies`. Quote, execution,
  eligibility and metrics behavior live in optional capabilities. Detect each
  complete interface through its method-presence guard in capabilities.ts,
  never `instanceof` or provider-id checks. Do not add unused future interfaces.
- All USD/amount values in contract types are **decimal strings**; convert to
  wire numbers only at the provider HTTP boundary.
- **An on-chain catalogue read takes its endpoint from `ctx.catalogueRpcUrl`**
  (`resolveCatalogueRpcUrl`, src/solana-rpc.ts), never from `ctx.env`. The
  catalogue sync answers it with the preferred endpoint of the requested
  cluster's managed pool; null means no endpoint, which `resolveCatalogueRpcUrl`
  refuses with `PROVIDER_NOT_CONFIGURED` before any read. `EarnRuntimeEnvironment`
  carries credentials only: `SOLANA_RPC_URL` and the `SOLANA_<CLUSTER>_RPC_URL`
  pins are gone from it, so a provider cannot fall back to the process default.
- Registry: `EARN_PROVIDER_CLIENTS` (src/index.ts) + fail-closed
  `resolveEarnProviderClient` — DB provider ids are open strings and MUST be
  resolved through this, never direct-indexed.
- Optional capabilities include live metrics, vault-direct (deposit + read),
  vault-withdraw,
  vault-queued-withdraw, provider-operated par redemption, deposit eligibility,
  and the two live quotes (deposit and withdrawal previews). All are
  method-presence guards in capabilities.ts,
  and a provider may implement any subset. `supportsDepositEligibility` is a
  provider-side KYC check MONEY-IN paths consult, never exits; WisdomTree
  implements it over its Connect wallet registry. Kamino has live metrics,
  vault-direct, vault-withdraw (PRO-1702), and both quotes (`@sdp/kamino`);
  Veda implements both instant and queued vault exits (see
  `docs/decisions/0003-veda-vault-withdrawals.md`). Hastra defaults to the
  distinct operator-completed par-redemption capability; never model it as a
  solver queue. Its instant Jupiter exit is optional behind the API's
  default-off `EARN_HASTRA_DEX_EXIT_ENABLED` gate and still requires
  `JUPITER_SWAP_API_KEY`. Disabling that lane must not change the atomic
  settlement or recovery semantics of an already recorded DEX movement. A
  deposit-only provider's exit route answers 501, which is a statement about
  SDP's plumbing rather than about anyone's right to their money.
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
- New deposits require an admitted execution path and a supported way out.
  Discovery-only strategies never authorize a deposit by their presence alone.
- **Persistence and visibility are separate.** A provider's distillation indexes
  sources within its declared support. The catalogue sync deprecates unlisted
  active strategies and retains their stable exit metadata; operator pauses
  remain sticky. Legacy strategy reads apply the reviewed execution shelf,
  while core discovery can show catalogue-only rows. Deposit admission still
  enforces that shelf. Keep product curation out of provider clients.
- Missing required provider configuration ⇒ throw `PROVIDER_NOT_CONFIGURED`
  **before** any network call.

## RPC budget (hard rule)

Every Treasury refresh re-reads every position live, so each call a provider
makes is paid per holding per refresh, against provider rate limits and the
Cloud NAT's 64 ports per instance per destination. Every provider path (reads,
quotes, builds, reconciliation) stays as lean as it can without losing
accuracy:

- **Live stays live.** Balances, shares, exchange rates, reserves, vesting and
  clock inputs, prices and quotes are read on every call. Never cache one.
- **Static is read once.** Program validation, PDAs, mint decimals and
  admin-set config are cached per (cluster, endpoint, account) with a TTL.
  Never cache a failure, and evict a cached client whose validation rejects.
- **No per-call construction cost.** Reuse a validated client instead of
  building one, and paying its validation, on every read.
- **One fetch per account per operation.** Never re-read an account the
  operation already holds; batch independent accounts into one
  `getMultipleAccounts`.
- **Share identical concurrent reads** in flight only: process-wide, keyed by
  endpoint and any `minContextSlot`, and joined only after the caller's read
  floor (`packages/sdp-rpc/CLAUDE.md`, "Read floors").
- **No unfiltered `getProgramAccounts`.** Derive the PDA, or filter server-side
  with `memcmp`/`dataSize`.
- **No unused round trips.** No `getBlockTime` or `getSlot` whose answer is
  discarded or already in a returned context slot.
- **Prove it.** A change to any of these paths states its before/after request
  count and sequential round trips, and a test pins the count by counting
  requests through a fake transport.

Reference point: Veda's provider paths went from a fresh SDK client per call
(22 requests per holding, 14-32 per deposit or exit, 22-68 per queue operation)
to 2 warm per operation (3 for a sponsored first deposit, 4 for a sponsored
first queue request), with identical values, by reading every account the SDK
touches in one batch and serving the SDK's own re-reads from it (`@sdp/veda`
CLAUDE.md, "Every operation reads each account once").

Atomic-only funding leaves successful deposit RPC counts unchanged: one compute
probe and one final simulation for a successful composed attempt. If compact
composition is oversized, refuse instead of adding the former baseline balance
read and two standalone-swap simulations. No split-swap status polling or second
deposit build follows.

## Conventions

- New provider = subclass `providers/stub.ts` (`StubEarnClient`), register in
  `EARN_PROVIDER_CLIENTS`, add the `./providers/<id>/client` package export.
  A registry-consistency test in src/index.test.ts fails if any of these is
  missing for an id in `EARN_PROVIDERS`.
- All HTTP goes through `providerFetch`/`providerFetchJson` (src/fetch.ts) —
  never raw `fetch` in a client.
- **`error` on a failure body is read as BOTH an object and a bare string**
  (`extractProviderErrorMessage`). Measured 2026-08-14: a provider rejects a
  request with `{"error":"Invalid query params: unknown parameter(s)","code":
  "unknown_parameters",…}` — `error` is a STRING. Reading only `error.message`
  made every such 4xx fall back to `"<provider> request failed with status
  <n>"`, which names the status and explains nothing, so a refused write reached
  the dashboard with its reason stripped. Do not narrow these shapes again; the
  provider's own sentence is the most useful thing on this path. It picks the
  first NON-BLANK of `error` / `message` / `reason` — the first _present_ one
  would let `error: ""` beside a real `message` select the blank and fall back,
  discarding an explanation the body did carry. The chosen sentence, and
  whatever an `errorDetails` normalizer lifts, go through `@sdp/redaction`
  before they land on the error (PRO-1995): the message is returned to API
  callers, and the envelope redacts credentials only. `@sdp/redaction` is the
  package's one dependency besides `@sdp/types`; it is dependency-free, so the
  hourly cron still loads no chain SDK.
- Tests: node:test (`pnpm --filter @sdp/earn test`), **no network** — stub
  global fetch per the canonical pattern in src/fetch.test.ts. Every new client
  method needs mapping + error-taxonomy coverage.
- Catalogue coverage questions (what a provider offers vs what distillation
  drops, and why) are answered per provider by the `earn:inventory:*` scripts in
  apps/sdp-api (e.g. `earn:inventory:kamino` regenerates
  `docs/earn/kamino-catalogue-inventory.md`).

## Registered is not the same as offered

`EARN_PROVIDERS` is what this deployment can talk to; `EARN_PROVIDER_SURFACING`
(both in `packages/sdp-types/src/provider-access.ts`) is what SDP sells today.
An un-surfaced provider keeps its client, credentials, catalogue sync and
metrics refresh, but disappears from discovery.
Core deposit admission also requires a surfaced provider.

**Nothing in this package reads it, and nothing should.** Surfacing is a product
policy enforced at the API's read/write boundary, exactly like
`HIDDEN_STRATEGY_TERMS`; a client here gates on credentials alone, the same rule
that keeps feature flags out of this package. Keeping the sync provider-blind is
what makes the DB a truthful inventory and re-surfacing a deploy rather than an
hour's wait.

The invariant it must never break is the one at the top of "Hard invariants":
surfacing gates the way IN (a new strategy deposit) and nothing else, so it
cannot trap funds. §6 of `docs/contributing/earn-pluggability-playbook.md` is the
checklist.

## Cross-package coupling

- Core DTOs shared by Treasury and Embedded Yield live in
  `packages/sdp-types/src/earn-core.ts` and `operations.ts`; legacy wire DTOs
  remain in `earn.ts`.
  Legacy deposit, deposit-history and direct-withdrawal response schemas live
  in `@sdp/types/earn-wire`; internal OpenAPI reuses those parsers.
  External movement responses declare atomic or provider-order `settlement`.
  Consumers must not interpret a missing settlement kind as atomic completion.
- Curators/categories are open-string registries in `@sdp/types` — adding one
  is a data change; do not introduce closed curator unions anywhere.
- Env credential names follow `<PROVIDER>_API_KEY` / `<PROVIDER>_SANDBOX_API_KEY`;
  a drift test in apps/sdp-api asserts turbo.json + secret-keys.mjs carry them.
- Module gating is not this package's job. The release channel decides Earn,
  read only by the API gate (`isEarnEnabled`) and the web flags — a client here
  gates on credentials alone and must never read a feature flag.
