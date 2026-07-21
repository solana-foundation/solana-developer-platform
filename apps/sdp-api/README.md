# SDP API

The core Solana Developer Platform API, built as a Node.js service with Postgres and Redis and deployed to Cloud Run.

## What is SDP API?

The SDP API provides a unified interface for blockchain operations on Solana, including:

- **Wallets & Custody** — create and manage wallets with custodial integrations (Privy, Coinbase CDP, Turnkey, Fireblocks, Para)
- **Token Issuance** — mint, freeze, and manage SPL tokens
- **Payments** — send SOL and SPL token transfers with compliance screening
- **Compliance** — AML/KYC screening via TRM, Chainalysis, Elliptic, or Range
- **On/Off Ramps** — integrate fiat on/off-ramps via MoonPay, Lightspark, or BVNK
- **Organizations & Projects** — multi-tenant project management with API key authentication

## Public API Routes

The API exposes these public REST endpoints (all require API key or session token):

| Family | Path | Use Case |
|---|---|---|
| **Health** | `GET /health` | Health check (no auth) |
| **Wallets** | `POST/GET /v1/wallets/*` | Create, list, manage wallets |
| **Issuance** | `POST/GET /v1/issuance/*` | Mint and manage tokens |
| **Payments** | `POST/GET /v1/payments/*` | Transfer funds |
| **Compliance** | `POST /v1/compliance/*` | Screen addresses/transactions |
| **Projects** | `POST/GET /v1/projects/*` | Manage API projects |
| **API Keys** | `POST/GET /v1/api-keys/*` | Create and manage API keys |

## Internal Routes (Maintainers Only)

- `/allowlist/*` — Admin allowlist management
- `/webhooks/clerk/link-orgs` — Clerk org sync webhook
- `/auth/*` — Session/token auth flows
- `/v1/rpc/*` — Solana RPC proxy (internal)
- `/v1/organizations/*` — Multi-tenant org management (internal)
- `/v1/members/*` — Team member management (internal)
- `/onboarding/*` — Internal onboarding status

## Local Development

### Prerequisites

- **Node.js 22+**
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

   # Optional: local Kora, only when FEE_PAYMENT_PROVIDER=kora
   pnpm kora:up

   # API with team/Doppler configuration (keep this process running)
   pnpm dev:api:local
   ```

   External contributors using only `.env.local` can replace the final command
   with `pnpm -C apps/sdp-api dev:local` so no Doppler session is required.

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

Kora is a fee-payment provider, not a signing provider. To use local Kora,
set `FEE_PAYMENT_PROVIDER=kora` and `KORA_RPC_URL=http://127.0.0.1:8080`
instead. For managed custody, choose a supported `SIGNING_PROVIDER` and add
that provider's credentials as shown below and in `.env.local.example`.

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

In self-hosted mode every configured provider is automatically entitled
regardless of organization tier. Per-org `providerOverrides` still apply as
a disable-only mechanism.

For the Clerk side of self-hosting (account creation, JWT template, webhook
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
MOONPAY_API_KEY=pk_...
MOONPAY_SECRET_KEY=sk_...
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
- Running Kora instance (`pnpm kora:up`)
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

- Relevant pushes to `main` deploy to the dev service.
- A merged `chore(main): release X.Y.Z` release commit deploys to production.
- Manual production workflow dispatch can redeploy an existing Git SHA image without rebuilding it.

Automated dev deployments and push-triggered production releases update and
execute the migration job before deploying the API. Production then verifies a
no-traffic candidate revision before promoting the service and reconciliation
cron job to the same immutable image. Manual production redeploys leave the
migration job unchanged. Runtime environment variables and secret references
are managed on the GCP resources rather than written by the image deployment.

See [`docs/ops/release-operations.md`](../../docs/ops/release-operations.md) for details.

## Architecture

- **Cloud Run** — Hosted Node.js API service and one-shot jobs
- **Postgres 16** — Application database, hosted with managed connectivity in deployed environments
- **Redis** — API-key, rate-limit, cache, and session storage
- **Cloud Run jobs and scheduler** — Database migrations and transfer reconciliation
- **Kora** — Optional local fee-payer service

## Contributing

- Follow the repo's TypeScript conventions (see `AGENTS.md`)
- Add tests for new routes (`packages/sdp-api-integration/src/tests/`)
- Update OpenAPI comments in route handlers
- Test locally before pushing

For full contribution guidelines, see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Support

- **Public docs**: https://platform.solana.com/docs
- **GitHub Issues**: https://github.com/solana-foundation/solana-developer-platform/issues
