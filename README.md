# Solana Developer Platform

The unified API and dashboard for building blockchain applications on Solana. Create wallets, issue tokens, process payments, and manage custody — all with a single integration.

> **Note:** SDP is devnet-only for now. Mainnet support is not part of the public getting-started path yet.

## What is SDP?

The Solana Developer Platform (SDP) provides a comprehensive set of APIs and tools for developers to:

- **Create and manage wallets** — Support multiple custody providers (Privy, Coinbase CDP, Turnkey, Fireblocks, Para)
- **Issue tokens** — Mint, transfer, and freeze SPL tokens with ease
- **Process payments** — Send SOL and SPL tokens with built-in compliance screening
- **Manage compliance** — Integrate AML/KYC screening (TRM, Chainalysis, Elliptic, Range)
- **Enable on/off-ramps** — Connect fiat gateways (MoonPay, Lightspark, BVNK)
- **Multi-tenant management** — Organize projects, teams, and API keys

**Live platform**: https://platform.solana.com/

**API Documentation**: https://platform.solana.com/docs

## Getting Started

### For Users & Application Developers

If you're building with SDP (not contributing to the repo):

1. **Sign up**: https://platform.solana.com/sign-up
2. **Create a project** and generate API keys
3. **Read the docs**: https://platform.solana.com/docs
4. **Integrate the REST API** using your language of choice

See the [public API reference](https://platform.solana.com/docs) for endpoint details.

### For Contributors

Want to contribute to the SDP codebase? Start here:

#### Prerequisites

- **Node.js 20+**
- **pnpm 10.15.1+** — Install: `npm install -g pnpm`
- **Git**
- **Doppler CLI** — Install: `brew install dopplerhq/cli/doppler` (or see [doppler.com/docs/cli](https://docs.doppler.com/docs/cli)). Required to run `pnpm dev` and `pnpm test`.

#### Quick Setup (No Private Accounts)

1. **Clone and install**:
   ```bash
   git clone https://github.com/solana-foundation/solana-developer-platform.git
   cd solana-developer-platform
   pnpm install
   ```

2. **Set up local environment**:
   ```bash
   # Copy environment template
   cp apps/sdp-api/.dev.vars.example apps/sdp-api/.dev.vars

   # Open apps/sdp-api/.dev.vars and set SOLANA_RPC_URL=https://api.devnet.solana.com
   ```

3. **Start local infrastructure**:
   ```bash
   # Terminal 1: Database
   pnpm db:postgres:up
   pnpm --filter @sdp/api db:postgres:bootstrap

   # Terminal 2: Kora (fee-payer service) — optional
   pnpm kora:up

   # Terminal 3: Dev server
   pnpm dev
   ```

4. **Try the API**:
   - API: http://localhost:8787
   - OpenAPI Docs: http://localhost:8787/docs
   - Dashboard: http://localhost:3000

#### What Works Without Private Accounts

✅ **Full functionality**:
- Unit tests
- API exploration and testing
- Local wallet creation (Kora-based)
- Token operations (mint, transfer, freeze)
- Documentation site

❌ **Requires vendor account** (free tiers available):
- **Dashboard auth**: Clerk (free tier)
- **Custody providers**: Privy, Coinbase CDP, Turnkey, etc. (business accounts)
- **Compliance screening**: TRM, Chainalysis, Elliptic, Range (business accounts)
- **Fiat ramps**: MoonPay, Lightspark, BVNK (business accounts)
- **Integration tests**: Requires Privy credentials

See [apps/sdp-api/README.md](apps/sdp-api/README.md) for detailed setup instructions.

## Repository Structure

```
solana-developer-platform/
├── apps/
│   ├── sdp-api/              # Core REST API (Cloudflare Workers)
│   ├── sdp-web/              # Dashboard UI (Next.js)
│   └── sdp-docs/             # Public documentation site
├── packages/
│   ├── sdp-types/            # Shared TypeScript types (internal)
│   ├── sdp-api-integration/  # Integration test suite (internal)
│   └── ...                   # Other shared packages
├── infra/
│   ├── postgres/             # Local database setup
│   ├── kora/                 # Fee-payer service setup
│   └── ...
└── docs/
    └── ops/                  # Operator/maintainer documentation
```

## Public API Overview

The REST API provides these public endpoints (all require API key or session token):

| Family | Purpose | Examples |
|---|---|---|
| **Wallets** | Create and manage blockchain accounts | `/v1/wallets`, `/v1/wallets/initialize` |
| **Issuance** | Mint and manage SPL tokens | `/v1/issuance/tokens`, `/v1/issuance/tokens/{tokenId}/mint` |
| **Payments** | Send SOL and tokens | `/v1/payments/transfers`, `/v1/payments/transfers/prepare` |
| **Compliance** | Screen addresses and transactions | `/v1/compliance/address-screenings` |
| **Projects** | API project management | `/v1/projects` |
| **API Keys** | Manage access tokens | `/v1/api-keys` |
| **Health** | Service status | `GET /health` |

**Full API Reference**: https://platform.solana.com/docs

## Package Visibility

| Package | Category | For External Use? |
|---|---|---|
| `@sdp/types` | Internal | ❌ Use public REST API instead |
| `@sdp/api-integration` | Internal | ❌ Maintainer-only test harness |
| `sdp-api` (app) | Hybrid | ✅ Public API + internal routes |
| `sdp-web` (app) | Hybrid | ✅ Public landing + internal dashboard |
| `sdp-docs` (app) | Public | ✅ External documentation site |

See individual `README.md` files in each directory for details.

## Running Tests

### Unit Tests (No External Dependencies)

```bash
pnpm test
```

### Integration Tests (Requires Privy + Kora)

```bash
export SOLANA_RPC_URL="https://api.devnet.solana.com"
export KORA_RPC_URL="https://your-kora-devnet-instance.us-central1.run.app"
# export KORA_API_KEY="..."  # only if your Kora endpoint requires it
export PRIVY_APP_ID=your_app_id
export PRIVY_APP_SECRET=your_secret
pnpm test:integration
```

See [packages/sdp-api-integration/README.md](packages/sdp-api-integration/README.md) for details.

## Local Development with Doppler (Team Members)

If you have team Doppler access:

```bash
doppler login
pnpm dev
```

This injects all secrets automatically. See [docs/ops/doppler-secrets.md](docs/ops/doppler-secrets.md) for details.

## For Maintainers

Operator and maintainer documentation:

- **[Release Operations](docs/ops/release-operations.md)** — Deploy flow, versioning, rollback
- **[Doppler Setup](docs/ops/doppler-secrets.md)** — Secret management and CI/CD configuration
- **[Cloudflare Resources](docs/ops/cloudflare-resource-ids.md)** — Hyperdrive and KV namespace configuration

## Contributing

We welcome contributions! Before starting, please:

1. **Check existing issues** — Avoid duplicate work
2. **Fork and create a branch** — Use descriptive branch names
3. **Follow conventions** — See `AGENTS.md` for code patterns
4. **Write tests** — Cover new functionality
5. **Submit a PR** — Link related issues

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for full guidelines.

## License

This project is licensed under the [MIT License](LICENSE).

## Support

- **Issues & Feature Requests**: [GitHub Issues](https://github.com/solana-foundation/solana-developer-platform/issues)
- **Documentation**: https://platform.solana.com/docs
- **Community**: [Solana Developer Discord](https://discord.gg/solana)
- **Security**: [SECURITY.md](SECURITY.md)

## Project Status

Actively maintained and in public beta. We're improving documentation and onboarding constantly — feedback welcome!

---

**Last Updated**: April 2026
**Repository**: https://github.com/solana-foundation/solana-developer-platform
