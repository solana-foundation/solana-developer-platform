# SDP API (Cloudflare Workers)

The core API service for Solana Developer Platform, running on Cloudflare Workers edge runtime.

## Architecture

```
src/
├── index.ts              # Hono app entry point
├── routes/               # API route handlers
│   ├── health.ts         # Health checks
│   ├── organizations.ts  # Org management (allowlist-gated)
│   ├── api-keys.ts       # API key CRUD
│   ├── members.ts        # Team member invitations
│   └── allowlist.ts      # Admin allowlist management
├── services/             # Business logic layer
│   ├── kv.service.ts     # KV caching for API keys
│   ├── audit.service.ts  # Audit logging
│   └── allowlist.service.ts
├── middleware/           # Request processing
│   ├── auth.ts           # API key validation (KV → D1)
│   ├── rate-limit.ts     # Sliding window rate limiting
│   ├── cors.ts           # Environment-aware CORS
│   └── request-id.ts     # Request ID propagation
├── lib/                  # Utilities
│   ├── crypto.ts         # ID generation, hashing
│   ├── errors.ts         # AppError class
│   └── response.ts       # Standardized responses
├── types/
│   └── env.d.ts          # Cloudflare bindings
└── db/
    ├── migrations/       # D1 schema migrations
    └── seed.sql          # Local dev seed data
```

## Cloudflare Bindings

Defined in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"              # D1 SQLite database

[[kv_namespaces]]
binding = "API_KEY_CACHE"   # Fast API key lookups
```

## Auth Flow

1. Request includes `X-API-Key` header
2. Check KV cache for key hash → org mapping
3. If miss, query D1 and populate cache
4. Attach org context to request
5. Rate limit by org

## Database Schema (D1)

- `organizations` - Registered enterprises
- `users` - Org members with roles
- `api_keys` - Hashed keys with permissions
- `allowlist` - Email/domain allowlist for registration
- `audit_logs` - Action tracking
- `invitations` - Pending member invites

## Adding New Routes

1. Create route file in `src/routes/`
2. Export Hono router
3. Import and mount in `src/index.ts`
4. Add corresponding types to `packages/sdp-types/`

## Commands

```bash
# Local development
pnpm dev

# Apply migrations to local D1
pnpm db:migrate

# Seed local database
pnpm db:seed

# Type check
pnpm typecheck

# Deploy to Cloudflare
pnpm deploy
```

## Cloudflare Environment Switching

1. Create D1 and KV resources for the dev environment.
2. Fill the `env.dev` IDs in `apps/sdp-api/wrangler.toml`.
3. Create `apps/sdp-api/.cloudflare.dev.env` from `apps/sdp-api/.cloudflare.dev.env.example`.
4. Deploy quickly with `pnpm --filter @sdp/api deploy:dev` or `apps/sdp-api/scripts/cloudflare-env.sh dev deploy:dev`.

When QA/prod access is ready, fill `env.staging` / `env.production` and use `deploy:qa` (or `deploy:staging`) and `deploy:production`.

## Environment Variables

Set via `wrangler.toml` or Cloudflare dashboard:

- `ENVIRONMENT` - `development` | `sandbox` | `production`
- `ALLOWED_ORIGINS` - CORS origins (comma-separated)

## TODO: Routes to Implement

### Issuance
- [ ] `POST /issuance/tokens` - Create token
- [ ] `POST /issuance/tokens/{id}/mint` - Mint
- [ ] `POST /issuance/tokens/{id}/mint/prepare` - Mint (unsigned)
- [ ] `POST /issuance/tokens/{id}/burn` - Burn
- [ ] `POST /issuance/tokens/{id}/burn/prepare` - Burn (unsigned)
- [ ] `GET /issuance/tokens/{id}` - Get token details
- [ ] Allowlist CRUD per token
- [ ] Freeze/seize endpoints

### Payments
- [ ] `POST /payments/wallets` - Create wallet
- [ ] `GET /payments/wallets/{id}/balance` - Balance
- [ ] `POST /payments/transfers` - Send (custody)
- [ ] `POST /payments/transfers/prepare` - Send (unsigned)
- [ ] `POST /payments/transfers/confidential` - Private transfer
- [ ] `GET /payments/transfers` - History
- [ ] Solana Pay request generation

### Transactions (low-level)
- [ ] `POST /transactions/prepare` - Build unsigned tx
- [ ] `POST /transactions/simulate` - Simulate
- [ ] `POST /transactions/sign` - Sign only
- [ ] `POST /transactions/send` - Sign + send
