# SDP API

The core Solana Developer Platform API, built as a Node.js service with Postgres and Redis and deployed to Cloud Run.

## What is SDP API?

The SDP API provides a unified interface for blockchain operations on Solana, including:

- **Wallets & Custody** — create and manage wallets with the built-in local signer or a custodial integration (Privy, Coinbase CDP, Turnkey, Fireblocks, Para, DFNS, IBM Digital Asset Haven, Utila). Anchorage is provisioning-only: it has no keychain signing adapter, so it can create and delete wallets but never signs.
- **Token Issuance** — mint, freeze, and manage SPL tokens
- **Payments** — send SOL and SPL token transfers with compliance screening
- **Compliance** — AML/KYC screening via TRM, Chainalysis, Elliptic, or Range
- **On/Off Ramps:** integrate fiat on/off-ramps via MoonPay or Stripe
- **Earn:** discover yield strategies and build self-custodial deposit or withdrawal transactions
- **Organizations & Projects** — multi-tenant project management with API key authentication

## Public API Routes

The API exposes these public REST endpoints. Most require an API key or Clerk session
token. Earn strategy reads, deposit/direct-withdrawal previews and unsigned
instant builds, withdrawal-route discovery, and queued-withdrawal previews also
accept anonymous requests. Submits, queued request/cancellation actions,
positions, movements, earnings, and the rest of the tenant control plane remain
authenticated.

| Family | Path | Use Case |
|---|---|---|
| **Health** | `GET /health` | Health check (no auth) |
| **Wallets** | `POST/GET /v1/wallets/*` | Create, list, manage wallets |
| **Issuance** | `POST/GET /v1/issuance/*` | Mint and manage tokens |
| **Payments** | `POST/GET /v1/payments/*` | Transfer funds |
| **Compliance** | `POST /v1/compliance/*` | Screen addresses/transactions |
| **Projects** | `POST/GET /v1/projects/*` | Manage API projects |
| **API Keys** | `POST/GET /v1/api-keys/*` | Create and manage API keys |
| **Earn** | `GET/POST /v1/earn/*` | Discover strategies, build transactions, and manage tracked positions |

## Internal Routes (Maintainers Only)

- `/admin/allowlist/*` — Admin allowlist management
- `/webhooks/clerk/link-orgs` — Clerk org sync webhook
- `/v1/rpc/*` — Solana RPC proxy (internal)
- `/v1/organizations/*` — Multi-tenant org management (internal)
- `/v1/members/*` — Team member management (internal)
- `/v1/onboarding/*` — Internal onboarding status

## Local Development

### Prerequisites

- **Node.js 24+**
- **pnpm 10.16+**
- **Docker or another Compose-compatible runtime** — Runs local Postgres 16 and Redis 7
- **Doppler CLI** — Recommended for team configuration. Install: `brew install dopplerhq/cli/doppler`; external contributors can use `.env.local` instead.

### Setup

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Configure environment variables:**

   **Option A: Using Doppler (team members)**
   ```bash
   doppler login
   ```

   Run root commands with your personal config (`DOPPLER_CONFIG=dev_personal pnpm dev`)
   and set the [required variables](#required-environment-variables) in it. It inherits
   the shared Development Clerk instance, which cannot deliver webhooks to your machine,
   so new organizations never link. Point it at your own Clerk app instead
   ([`clerk-setup.md`](docs/self-hosting/clerk-setup.md)): override `CLERK_ISSUER`,
   `CLERK_JWKS_URL`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
   `CLERK_WEBHOOK_SECRET` and `WEBHOOK_INGEST_DOMAIN`.

   **Option B: Using local `.env.local` (external contributors)**
   ```bash
   cp apps/sdp-api/.env.local.example apps/sdp-api/.env.local
   # Edit .env.local with your values (see below)
   ```

3. **Start the development environment:**

   To run the workspace, use:

   ```bash
   pnpm dev
   ```

   That command starts local Postgres and Redis along with the development
   processes. To run only the API, start its dependencies and process
   separately:

   ```bash
   # Postgres and Redis (runs in the background)
   pnpm db:postgres:up

   # Optional: local devnet + mainnet-fork Kora; writes the API's Kora env
   # (FEE_PAYMENT_PROVIDER=kora) to .secrets/kora-local/api.env
   pnpm kora:local:up

   # API and cron worker with team/Doppler configuration (keep this process running)
   pnpm dev:api
   ```

   The API (`scripts/dev-api.mjs`) migrates and serves with cron off; the cron
   worker (`scripts/dev-worker.mjs`, port 8789) waits for it and runs the
   reconcilers, like the deployed API and worker services. Turbo prefixes their
   logs `@sdp/api:dev` and `@sdp/api:dev:worker`.

   External contributors using only `.env.local` can replace the final command
   with `pnpm -C apps/sdp-api dev` and `pnpm -C apps/sdp-api dev:worker` so no
   Doppler session is required.

   The API development process waits for Postgres and Redis and applies local
   migrations before starting the server.

### Required Environment Variables

Create `apps/sdp-api/.env.local` with at least:

```bash
# Local development without hosted custody or fee-payment dependencies
SDP_DEPLOYMENT_MODE=self_hosted

# Use an RPC endpoint that supports the methods exercised by the API
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=<your-key>

# Wallet signer (generate both values with `pnpm --filter @sdp/api keygen:local`)
SIGNING_PROVIDER=local
CUSTODY_PRIVATE_KEY=<base58-encoded keypair>
CUSTODY_ENCRYPTION_KEY=<base64-encoded 256-bit key>

# Native fee payment can reuse the local custody key in development
FEE_PAYMENT_PROVIDER=native
FEE_PAYER_PRIVATE_KEY=<base58-encoded keypair>
```

Kora is a fee-payment provider, not a signing provider. `pnpm dev` starts
the stack with a devnet Kora (`127.0.0.1:18081`, real devnet RPC) and a mainnet
Kora on a Surfpool mainnet fork (`127.0.0.1:18080`, upstream `SOLANA_MAINNET_RPC_URL`), and points the API at both
via `.secrets/kora-local/api.env`; `pnpm kora:local:down` tears them down. Without
`SOLANA_MAINNET_RPC_URL` (Doppler dev has it) the mainnet Kora is skipped and
only the devnet one runs. To
use a single Kora by hand, set `FEE_PAYMENT_PROVIDER=kora` and that cluster's
`KORA_<CLUSTER>_URL` (`KORA_DEVNET_URL` / `KORA_MAINNET_URL`) instead. For managed custody, choose a supported `SIGNING_PROVIDER` and add
that provider's credentials as shown below and in `.env.local.example`.

Keyless Earn requests map `ENVIRONMENT=development` to sandbox and
`ENVIRONMENT=production` to production. Anonymous quote and build traffic has
a separate paid-upstream budget configured with
`EARN_ANONYMOUS_RPC_MAX_REQUESTS` and
`EARN_ANONYMOUS_RPC_WINDOW_SECONDS`. API-key requests continue to use their
project environment and authenticated quota. At startup, the API validates and
logs the resolved anonymous Earn environment from `ENVIRONMENT`; verify that
event before exposing a non-production deployment. Outside Cloud Run, forwarded
client addresses are ignored unless `TRUST_PROXY_HEADERS=true`; enable it only
behind an ingress that replaces caller-supplied `X-Forwarded-For` values.

### Release Channel (which modules run)

`SDP_RELEASE_CHANNEL` is required. It sets the least mature module stage a
deployment runs: `experimental` (every module), `beta` or `stable`. Each
module's stage lives in `packages/sdp-types/src/release-channels.ts`; see
[ADR 0005](../../docs/decisions/0005-release-channels.md). The API, its jobs and
the dashboard all read it and refuse to start without it.

**Run locally on stable:** set `SDP_RELEASE_CHANNEL=stable` in
`apps/sdp-api/.env.local` (the example file has the line) and restart `pnpm dev`.
The root `pnpm dev` loads that file for both the API and the dashboard, and it
beats Doppler. Check with `curl -s localhost:8787/health`, which reports
`releaseChannel`.

- Without the line, Doppler `dev` (and the personal and CI configs that inherit
  from it) supplies `experimental`; `pnpm -C apps/sdp-api dev` alone defaults to
  `experimental` too.
- One run without editing the file, when the file does not set it:
  `DOPPLER_PRESERVE_ENV=SDP_RELEASE_CHANNEL SDP_RELEASE_CHANNEL=stable pnpm dev`.
  A plain shell value is ignored, because Doppler sets the key.
- Docker Compose: `SDP_RELEASE_CHANNEL=stable docker compose up` (both compose
  files default to `experimental`).
- Modules outside the channel answer 403 "The <module> module is not available
  in this release channel." and are hidden in the dashboard.

### Optional: Custody Integrations

To test with specific custody providers, add their credentials:

```bash
# Coinbase CDP
SIGNING_PROVIDER=coinbase_cdp
COINBASE_CDP_API_KEY_ID=your_key_id
COINBASE_CDP_API_KEY_SECRET=your_secret
COINBASE_CDP_WALLET_SECRET=base64_secret
COINBASE_CDP_NETWORK=solana-devnet

# Privy
SIGNING_PROVIDER=privy
PRIVY_APP_ID=your_app_id
PRIVY_APP_SECRET=your_app_secret
```

See `.env.local.example` for all available options.

### Self-Hosted Mode (no third-party providers)

Run SDP with only the local signer + native fee-payment + a single RPC
endpoint — no DFNS / Privy / Fireblocks / Coinbase / Para / etc. accounts
required. In `apps/sdp-api/.env.local`:

```bash
SDP_DEPLOYMENT_MODE=self_hosted

# Custody — generate values with the command below
SIGNING_PROVIDER=local
CUSTODY_PRIVATE_KEY=<base58-encoded keypair>
CUSTODY_ENCRYPTION_KEY=<base64-encoded 256-bit key>  # required by EncryptionService

# Fee payment — native avoids the public Kora dependency
FEE_PAYMENT_PROVIDER=native
FEE_PAYER_PRIVATE_KEY=<base58-encoded keypair>

# RPC — any single endpoint. The public devnet endpoint
# (https://api.devnet.solana.com) returns 403 for getTokenAccountsByOwner,
# so wallet-balance queries will log "failed to fetch SPL balances" on every
# refresh. Use a free Helius / Triton / QuickNode / Validation Cloud key or a
# local solana-test-validator instead.
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=<your-key>
```

Generate `CUSTODY_PRIVATE_KEY` and `FEE_PAYER_PRIVATE_KEY` values:

```bash
pnpm --filter @sdp/api keygen:local
```

The script prints `PUBLIC_KEY=…`, `CUSTODY_PRIVATE_KEY=…`, and
`CUSTODY_ENCRYPTION_KEY=…` lines you can paste straight into `.env.local`,
plus a commented `# FEE_PAYER_PRIVATE_KEY=…` hint. Uncomment the hint to
reuse the custody keypair as the fee payer in local dev (the same keypair
can serve both roles); use distinct keys for any non-dev deployment. Add
`--quiet` to print only the custody secret (useful for piping into `pbcopy`).

Provider access is organization-scoped in every deployment mode. Configured,
generally available providers work for every organization. Manual providers,
including the local signer, need an override in the Clerk organization's
private metadata:

```json
{ "sdp": { "providerOverrides": { "custody": { "local": true } } } }
```

Set it in the Clerk dashboard (Organizations → your org → Metadata → Private;
the `organization.updated` webhook syncs it) or with
`pnpm --filter @sdp/api org:tier:local --clerk-org-id <org_…> --tier individual --overrides '{"custody":{"local":true}}'`.
Without it, choosing the local signer returns `403 Local requires manual activation`.

For the Clerk side of self-hosting (account creation, session token customization, webhook
relay via an ngrok tunnel), follow [`docs/self-hosting/clerk-setup.md`](docs/self-hosting/clerk-setup.md).
The webhook handler is the only path that creates `organizations` rows
outside `pnpm db:seed:local`.

### Optional: Compliance & Ramp Integrations

```bash
# AML/KYC screening (pick one provider)
TRM_API_KEY=your_key
# OR
CHAINALYSIS_API_KEY=your_key
# OR
ELLIPTIC_API_TOKEN=your_token

# Fiat ramps
MOONPAY_SANDBOX_API_KEY=pk_test_...
MOONPAY_SANDBOX_SECRET_KEY=sk_test_...

```

## Running Tests

### Unit Tests

```bash
pnpm --filter @sdp/api test
```

The suite provisions isolated Postgres and Redis containers, so it requires a
working Docker-compatible runtime but no hosted provider dependencies. The test
database never touches your dev data, and migrations are applied automatically.

### Integration Tests

```bash
pnpm --filter @sdp/api-integration test
```

**Requires:**
- Privy credentials (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`)
- Running Kora instance (`pnpm kora:local:up`, then `KORA_DEVNET_URL=http://127.0.0.1:18081`)
- Funded Solana devnet account

## Database Migrations

The API uses Postgres for local, test, and deployed environments.

### Local migrations (Postgres)

```bash
pnpm --filter @sdp/api db:migrate:local
```

### Test database (Postgres)

The standard unit-test suite creates disposable Postgres and Redis containers
and applies migrations automatically. It does not use the local development
database.

For a manually managed local test database, `db:migrate:test` derives a `_test`
database name from `DATABASE_URL` (for example, `…/sdp` becomes `…/sdp_test`).
Set `TEST_DATABASE_URL` to target an explicit test database instead.

```bash
pnpm --filter @sdp/api db:migrate:test
```

This creates the explicit test database if it does not exist and applies all
pending migrations. The normal `pnpm --filter @sdp/api test` path does not need
this command because its disposable container is migrated during test setup.

### Deployed migrations (Postgres)

Hosted schema changes run through each environment's Cloud Run migration job
as part of the automated deployment. The job is updated to the intended image
and must succeed before the service rollout proceeds. A manual production image
redeploy intentionally does not update or execute the migration job.

A merge to `main` migrates stage first. When `main` carries migrations that
production has not applied (tracked by the `sdp_schema_sha` label on the prod
migrate job), the production merge deploy is held and, once stage is green,
the run dispatches `Apply pending migrations to prod`. That workflow lists the
pending migrations, waits in the `release-production` environment for a
reviewer who confirms the change has baked on stage, then deploys that commit
with its migrations. The approver may not have authored a pending migration,
the commit needs a green stage deploy, and an approved run cannot be re-run.
Migration-free merges deploy production without a stop. Because a rollback only moves traffic and never reverses the
schema, CI (`pnpm check:migration-compat`) rejects migrations the previous
image cannot run against. A migration that must break compatibility declares
`-- sdp:migration-compat: breaking` and ships in a PR that touches nothing
outside the migrations directory except test files. Production applies it only
once it serves the commit before it, and never restores the previous image
after it.

Migrations run while the previous revision serves traffic, so the runner caps
each lock wait at 5 s (`lock_timeout`) and retries the file a few times; locks
it acquires are still held until it commits. The same CI check rejects common
DDL that holds a blocking lock for a whole scan or build (an index without
`CONCURRENTLY`, a foreign key without `NOT VALID`, an unproven `SET NOT NULL`).
Rules, gaps and the `-- sdp:migration-locks: blocking` escape hatch:
`docs/ops/release-operations.md`, "Schema compatibility".

Do not run a deployed migration directly from a laptop with Doppler credentials.
For an exceptional manual operation, use the named Cloud Run migration job and
the environment's GCP deployment identity under the release operations runbook.

## API Documentation

### OpenAPI Spec

The API generates an OpenAPI 3.0 specification:

```bash
GET /openapi.json
```

Browse the docs at `http://localhost:8787/docs` when running locally.

### Public Docs Site

Full getting-started guides and tutorials: https://platform.solana.com/docs (or local `pnpm dev:docs`)

## Deployment

The hosted API is built as a container and deployed to Cloud Run through GitHub Actions:

- Every push to `main` deploys stage, then production when `CONTINUOUS_PROD_DEPLOY` is `true`; release commits deploy the same way.
- Manual production workflow dispatch can redeploy an existing Git SHA image without rebuilding it.

Stage deploys and merge deploys to production update and execute the migration
job before deploying the API. Production then verifies a no-traffic candidate
revision before promoting the service and the Worker service to the same
immutable image, and holds further deploys when the production canary fails,
leaving the rollback to a person. Releases and manual production redeploys leave the migration
job unchanged and refuse an image that adds migrations production has not
applied. Runtime environment variables and secret references
are managed on the GCP resources rather than written by the image deployment.

See [`docs/ops/release-operations.md`](../../docs/ops/release-operations.md) for details.

## Architecture

- **Cloud Run** — Hosted Node.js API service and one-shot jobs
- **Postgres 16** — Application database, hosted with managed connectivity in deployed environments
- **Redis** — API-key, rate-limit, cache, and session storage
- **Cloud Run** — the API service, the always-on Worker service (Cron Definitions), and the database migration job
- **Kora** — Optional local fee-payer service

### Reconciliation cron

Background work is a set of **Cron Definitions** (`src/cron/*.ts`, each built with `defineCron`; ADR 0011) run by one process: the always-on Worker service, which sets `DISABLE_CRON=false`. API replicas skip cron by default when `K_SERVICE` is set; self-hosted runtimes run it by default.

- Each definition declares its `schedule`, its `scope` (`cluster`: registered once per Environment, each run inside that Environment's cluster scope; `global`: registered once), its money `effect`, and an `enabled(env)` decision made once at registration. The full list is `CRON_DEFINITIONS` in `src/cron/runner.ts`.
- Every slot logs one `sdp_cron_run` event (`cron`, `environment`, `status`, `duration_ms`) to Loki. The statuses (`ok`, `error`, `skipped_overlap`, `disabled`) are defined on `CRON_RUN_STATUSES` in `@sdp/types/cron-runs`. A disabled definition still logs `disabled` on its schedule, and a slot that fires while the same registration's previous run is in flight logs `skipped_overlap` instead of starting a second run.
- Money Exits (`effect: "finishes"`: transfer settlement, sponsorship budgets, Earn vault movements, DvP, ramp replay) are always enabled; the private-channels withdrawal tracker is the one flagged exception, because it cannot run without the gateway configured.
- The **Earn strategy-catalogue sync** is hourly in effect behind `isEarnEnabled`: it is scheduled every five minutes and also runs once when the Worker starts (`runOnStart`), so a fresh database lists strategies within seconds, and every run claims an hourly Redis slot first (`runEarnCatalogueSyncIfDue`), so a boot run, the scheduled run and two Workers overlapping during a deploy never sync twice in one window. The slot is a claim token embedding its expiry; a failed sync releases it via compare-and-delete on its own token, and the sync is deadline-bounded (10 minutes, far under the claim expiry). It logs `sdp_earn_catalogue_sync` with `outcome: "synced" | "skipped"`.

## Contributing

- Follow the repo's TypeScript conventions (see `AGENTS.md`)
- Add tests for new routes (`packages/sdp-api-integration/src/tests/`)
- Update OpenAPI comments in route handlers
- Test locally before pushing

For full contribution guidelines, see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Support

- **Public docs**: https://platform.solana.com/docs
- **GitHub Issues**: https://github.com/solana-foundation/solana-developer-platform/issues
