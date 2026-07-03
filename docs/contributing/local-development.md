# Local Development Notes

This page keeps the longer contributor details out of the root README while preserving the setup and repository context that is useful once someone decides to work on SDP.

SDP is an enterprise development platform. Local development is intended for contributing to the platform and evaluating devnet workflows; full self-hosting is still a work in progress.

## Public API Areas

The public REST API is organized around these areas:

| Area | Purpose |
| --- | --- |
| Health | Service status |
| API keys | API key creation, scoping, and lifecycle |
| Wallets | Wallet creation and management |
| Projects | Project-level organization |
| Issuance | Token creation and token operations |
| Payments | SOL and token payment flows |
| Compliance | Address and transaction screening |

The OpenAPI source in `apps/sdp-api/src/openapi` is the source of truth for the public API. Generated API docs should be regenerated with the owning scripts instead of edited by hand.

## Repository Map

| Path | Purpose |
| --- | --- |
| `apps/sdp-api` | Cloudflare Workers API, OpenAPI source, route handlers, and data integrations |
| `apps/sdp-web` | Dashboard application |
| `apps/sdp-docs` | Public documentation site and generated API reference |
| `packages/sdp-types` | Shared runtime types and product constants |
| `packages/sdp-api-integration` | Maintainer-oriented integration tests |
| `infra/postgres` | Local Postgres setup |
| `docs/ops` | Operator and maintainer notes |

## Local Setup

Install dependencies:

```bash
pnpm install
```

Create a local API environment file:

```bash
cp apps/sdp-api/.dev.vars.example apps/sdp-api/.dev.vars
```

For basic devnet development, set:

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com
```

Start local services:

```bash
pnpm db:postgres:up
pnpm --filter @sdp/api db:postgres:bootstrap
pnpm dev
```

Useful local URLs:

| Service | URL |
| --- | --- |
| API | http://localhost:8787 |
| API docs | http://localhost:8787/docs |
| Dashboard | http://localhost:3000 |

## Provider-Backed Features

Some features need external vendor credentials and may not work in a clean local checkout:

| Feature | Typical dependency |
| --- | --- |
| Dashboard authentication | Clerk |
| Managed custody providers | Privy, Coinbase CDP, Turnkey, Fireblocks, Para, or similar |
| Compliance screening | TRM, Chainalysis, Elliptic, Range, or similar |
| Fiat ramps | MoonPay, Lightspark, BVNK, or similar |
| Integration tests | Provider credentials and devnet infrastructure |

Keep real credentials in local environment files or the team secret manager. Do not commit secrets or provider-issued tokens.

## Self-Hosting Status

The repository includes local development infrastructure and deployment-oriented helpers, but full self-hosting is not yet a polished public product path. Expect gaps around provider onboarding, production operations, secret management, compliance integrations, and mainnet readiness.

## Checks

Common checks:

```bash
pnpm --filter @sdp/api test
pnpm --filter @sdp/api typecheck
pnpm --filter sdp-docs check:links
pnpm --filter sdp-docs build
pnpm typecheck
```

Regenerate derived artifacts with:

```bash
pnpm -C apps/sdp-api openapi:generate
pnpm -C apps/sdp-docs generate:api
pnpm -C apps/sdp-docs generate:ai
```

## Maintainer Notes

Operational notes live under `docs/ops`. They may reference private deployment conventions and should be kept separate from public getting-started material.
