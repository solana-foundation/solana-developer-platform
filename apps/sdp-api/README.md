# SDP API

The core Solana Developer Platform API, built with Cloudflare Workers and D1/Hyperdrive database bindings.

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
| **RPC Proxy** | `POST /v1/rpc/*` | Proxy Solana RPC calls |

## Internal Routes (Maintainers Only)

- `/allowlist/*` — Admin allowlist management
- `/webhooks/clerk/link-orgs` — Clerk org sync webhook
- `/auth/*` — Session/token auth flows
- `/v1/organizations/*` — Multi-tenant org management (internal)
- `/v1/members/*` — Team member management (internal)
- `/onboarding/*` — Internal onboarding status

## Local Development

### Prerequisites

- **Node.js 20+**
- **pnpm 10.15.1+**
- **Doppler CLI** — Required to run dev and test commands. Install: `brew install dopplerhq/cli/doppler`
- **Local Postgres 16** or Cloud SQL connection (for D1)

### Setup

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Configure environment variables:**

   **Option A: Using Doppler (team members)**
   ```bash
   doppler login
   pnpm dev
   ```

   **Option B: Using local `.dev.vars` (external contributors)**
   ```bash
   cp apps/sdp-api/.dev.vars.example apps/sdp-api/.dev.vars
   # Edit .dev.vars with your values (see below)
   pnpm -C apps/sdp-api dev:local
   ```

3. **Start local infrastructure:**
   ```bash
   # Terminal 1: Postgres
   pnpm db:postgres:up
   pnpm db:postgres:bootstrap

   # Terminal 2: Kora (fee-payer service)
   pnpm kora:up

   # Terminal 3: API
   pnpm dev
   ```

### Required Environment Variables

Create `apps/sdp-api/.dev.vars` with at least:

```bash
# Solana RPC (required)
SOLANA_RPC_URL=https://api.devnet.solana.com

# Fee-payer service (required for wallet/payment operations)
KORA_RPC_URL=http://127.0.0.1:8080  # or use local Kora

# Signer (choose one)
SIGNING_PROVIDER=kora                 # Use local Kora with a devnet keypair
# OR
SIGNING_PROVIDER=coinbase_cdp         # Requires COINBASE_CDP_* vars
# OR
SIGNING_PROVIDER=privy                # Requires PRIVY_* vars
```

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

See `.dev.vars.example` for all available options.

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

No external dependencies required.

### Integration Tests

```bash
pnpm --filter @sdp/api-integration test:integration
```

**Requires:**
- Privy credentials (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`)
- Running Kora instance (`pnpm kora:up`)
- Funded Solana devnet account

## Database Migrations

The API uses D1 (Cloudflare's SQLite) in production and Postgres locally.

### Local migrations (Postgres)

```bash
pnpm --filter @sdp/api db:migrate:local
```

### Production migrations (D1)

```bash
# Dev environment
doppler run --config dev -- pnpm --filter @sdp/api db:migrate:dev

# Production environment
doppler run --config prd -- pnpm --filter @sdp/api db:migrate:production
```

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

### Dev Environment

```bash
doppler run --config dev -- pnpm --filter @sdp/api exec wrangler deploy --env dev
```

### Production Environment

Automated on tag push: `v*.*.*` or `solana-developer-platform-v*.*.*`

Manual deploy:
```bash
doppler run --config prd -- pnpm --filter @sdp/api exec wrangler deploy --env production
```

See [`docs/ops/release-operations.md`](../../docs/ops/release-operations.md) for details.

## Architecture

- **Cloudflare Workers** — Serverless compute
- **D1** — SQLite database (production)
- **Hyperdrive** — PostgreSQL connection pooling
- **KV** — Key-value store for API keys, rate limits, cache
- **Postgres 16** — Local development database
- **Kora** — Local fee-payer service (devnet signing)

## Contributing

- Follow the repo's TypeScript conventions (see `AGENTS.md`)
- Add tests for new routes (`packages/sdp-api-integration/src/tests/`)
- Update OpenAPI comments in route handlers
- Test locally before pushing

For full contribution guidelines, see [`CONTRIBUTING.md`](../../CONTRIBUTING.md) (forthcoming).

## Support

- **Public docs**: https://platform.solana.com/docs
- **GitHub Issues**: https://github.com/solana-foundation/solana-developer-platform/issues
- **Slack**: Internal team channel (maintainers only)
