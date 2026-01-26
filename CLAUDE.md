# Solana Developer Platform (SDP)

API-based developer launchpad for enterprises to build, test, and launch tokenized products on Solana.

## Product Overview

SDP provides enterprise-grade APIs that abstract blockchain complexity, enabling businesses to focus on their use cases rather than infrastructure.

### Core API Modules

| Module | Description | V1 Status |
|--------|-------------|-----------|
| **Issuance** | Token-2022 creation with compliance extensions | ✅ V1 |
| **Payments** | Transfers, Solana Pay, confidential transfers | ✅ V1 |
| **Trading** | Swaps between KYCed wallets | ❌ V2+ |

### Environments

| Environment | Network | Infrastructure |
|-------------|---------|----------------|
| Sandbox/Alpha | Devnet | Pre-selected providers |
| Beta | Devnet | Client's providers |
| Production | Mainnet-Beta | Client's providers |

## V1 Scope (Target: March 1, 2026)

### Issuance APIs
- `POST /issuance/tokens` - Create token with extensions
- `POST /issuance/tokens/{id}/mint` - Mint tokens
- `POST /issuance/tokens/{id}/burn` - Burn tokens
- Allowlist management (KYC/KYB, sanctions screening)
- **Privacy** - Confidential mint/burn (CRITICAL for V1)
- Freeze/seize controls

### Payments APIs
- `GET /payments/wallets/{id}/balance` - Check balance
- `POST /payments/transfers` - Send tokens (Kora gasless)
- `POST /payments/transfers/confidential` - Private transfers
- Solana Pay request links
- Transaction history
- Wallet aliases/nicknames
- On/off ramps (maybe V2)

### Two Signing Modes
Each mutation endpoint supports two modes:
- **Prepare** (`/prepare` suffix) - Returns unsigned tx, you sign
- **Execute** (default) - SDP custody provider signs and submits

## Sample Use Cases

1. **Stablecoin Issuance** - Issue permissioned stablecoin with allowlist
2. **Confidential Transfers** - PYUSD private transfers between approved wallets
3. **Cross-Border Payments** - Fiat → USDC to recipient wallet
4. **RWA Tokenization** - Issue real-world assets on Solana
5. **KYCed Swaps** - USDC ↔ RWA between verified wallets (V2)

## Infrastructure Partners

| Category | Partners |
|----------|----------|
| RPC/Node | Helius, QuickNode, Triton, Alchemy |
| Custody | Fireblocks, Turnkey, Anchorage, Squads, Crossmint, Dynamic |
| Compliance | TRM, Chainalysis, Elliptic, Range, Hypernative |
| On/Off Ramps | Ramp, BVNK, Moonpay, Bridge, LightSpark |

## Repository Structure

```
solana-developer-platform/
├── apps/
│   └── sdp-api/              # Cloudflare Workers API (Hono)
│       ├── src/
│       │   ├── routes/       # API route handlers
│       │   ├── services/     # Business logic
│       │   ├── middleware/   # Auth, rate limiting, CORS
│       │   ├── lib/          # Utilities
│       │   └── db/           # D1 migrations
│       └── wrangler.toml     # Cloudflare config
├── packages/
│   └── sdp-types/            # Shared TypeScript types
└── openapi/                  # OpenAPI spec (deployed to Vercel)
    └── sdp-api.yaml
```

## Tech Stack

- **Runtime**: Cloudflare Workers (edge)
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Auth**: API keys with KV → D1 fallback
- **Types**: Zod schemas + TypeScript
- **OpenAPI**: Deployed to Vercel (Swagger UI)

## Development

```bash
# Install dependencies
pnpm install

# Run API locally
pnpm --filter sdp-api dev

# Apply D1 migrations
pnpm --filter sdp-api db:migrate

# Type check
pnpm --filter sdp-api typecheck

# Deploy OpenAPI spec
cd openapi && vercel --prod
```

## Key Contacts

- **Product**: Catherine Gu (catherine.gu@solana.org)
- **Engineering**: Jon Wong (jon@solana.org)

## Important Notes

- Privacy features are CRITICAL for V1 - confidential transfers must work
- Wallet management is abstracted - enterprises don't manage keys directly
- All APIs handle signing via configured custody providers OR return unsigned tx
- Allowlist/KYC is mandatory for enterprise use cases
