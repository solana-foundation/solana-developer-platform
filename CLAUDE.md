# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Install dependencies
pnpm install

# Development (from root)
pnpm dev                              # Start all dev servers via Turbo
pnpm --filter sdp-api dev             # Run API with remote D1
pnpm --filter sdp-api dev:local       # Run API with local D1 (persisted)

# Linting & formatting (Biome)
pnpm lint                             # Check for lint issues
pnpm lint:fix                         # Auto-fix lint issues
pnpm format                           # Format all files
pnpm format:check                     # Check formatting without changes
pnpm check                            # Lint + typecheck combined

# Type checking
pnpm typecheck                        # Type check all packages

# Testing
pnpm test                             # Run all tests via Turbo
pnpm --filter sdp-api test            # Run API tests
pnpm --filter sdp-api test:watch      # Watch mode
pnpm --filter sdp-api test:coverage   # Generate coverage report

# Database migrations
pnpm --filter sdp-api db:migrate:local      # Apply to local D1
pnpm --filter sdp-api db:migrate:staging    # Apply to staging
pnpm --filter sdp-api db:migrate:production # Apply to production
pnpm --filter sdp-api db:seed:local         # Seed local database

# Deployment
pnpm --filter sdp-api deploy                # Deploy to default env
pnpm --filter sdp-api deploy:staging        # Deploy to staging
pnpm --filter sdp-api deploy:production     # Deploy to production
```

## Architecture Overview

**Monorepo Structure**: pnpm workspace with Turbo orchestration

```
apps/sdp-api/           # Cloudflare Workers API (Hono framework)
  src/
    index.ts            # Entry point, app setup, route mounting
    routes/             # API route handlers (organizations, api-keys, health)
    middleware/         # Auth, CORS, rate-limiting, request-id
    services/           # Business logic (KV caching, audit, allowlist)
    lib/                # Utilities (ID generation, hashing, responses)
    db/migrations/      # D1 SQL migration files

packages/sdp-types/     # Shared TypeScript types
  src/
    permissions.ts      # Permission system, roles
    organizations.ts    # Org, User, Member types
    api-keys.ts         # API key types, CachedApiKey
    transactions.ts     # Prepare/Execute transaction models

openapi/                # OpenAPI spec (Swagger UI deployed to Vercel)
```

## Key Patterns

**ID Generation** (using nanoid with prefixes):
- Organizations: `org_` + 16 chars
- Users: `usr_` + 16 chars
- API Keys: `key_` + 16 chars
- Members: `mem_` + 16 chars

**API Key Format**:
- `sk_test_*` for sandbox (devnet)
- `sk_live_*` for production (mainnet-beta)

**Response Format**:
```typescript
// Success: { data: T, meta: { requestId, timestamp } }
// Paginated: { data: T[], meta: { total, page, pageSize, hasMore, requestId } }
// Error: { error: { code, message, details? }, meta: { requestId } }
```

**Auth Flow**: API key in Authorization header → KV cache lookup (1hr TTL) → D1 fallback → set context

**Two Signing Modes** for mutation endpoints:
- Default: Execute (SDP custody provider signs)
- `/prepare` suffix: Returns unsigned transaction for client signing

## Cloudflare Bindings

```typescript
interface Env {
  DB: D1Database;           // SQLite database
  SDP_API_KEYS: KVNamespace;    // API key cache
  SDP_RATE_LIMITS: KVNamespace; // Rate limit counters
  SDP_CACHE: KVNamespace;       // General cache
  ENVIRONMENT: "development" | "staging" | "production";
  API_KEY_PEPPER?: string;  // Optional key hashing pepper
}
```

## Testing

**Framework**: Vitest with `@cloudflare/vitest-pool-workers` for realistic D1/KV testing.

**Test Structure**:
```
apps/sdp-api/src/
├── lib/*.test.ts           # Unit tests (no mocks needed)
├── middleware/*.test.ts    # Middleware tests
├── routes/*.test.ts        # Integration tests
└── test/
    ├── setup.ts            # Global test setup
    ├── fixtures/           # Test data (organizations, api-keys)
    ├── mocks/              # D1/KV mock helpers
    └── helpers/            # Test utilities (auth setup)
```

**Run single test file**:
```bash
pnpm --filter sdp-api test src/lib/crypto.test.ts
```

## Linting Rules (Financial Security)

Biome enforces these rules critical for financial applications:
- `noSecrets` - Prevents hardcoded credentials
- `noDoubleEquals` - Enforces strict equality (===)
- `noExplicitAny` - Requires proper typing
- `noUnusedVariables/Imports` - Keeps code clean

## Important Notes

- Privacy features (confidential transfers) are CRITICAL for V1
- All enterprise use cases require allowlist/KYC
- Enterprises don't manage keys directly - wallet management is abstracted
- TypeScript path aliases: `@/*` maps to `./src/*`, `@sdp/types` maps to shared types package
