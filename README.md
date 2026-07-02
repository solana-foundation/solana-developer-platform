# Solana Developer Platform

Solana Developer Platform (SDP) is an enterprise development platform for building Solana applications with wallets, token issuance, payments, compliance checks, and a hosted dashboard.

## Status

SDP is pre-mainnet software. The public repository and APIs are intended for enterprise development, evaluation, and devnet integrations.

This codebase has not been audited. Do not use it to custody production funds, run mainnet financial workflows, or protect regulated production activity without your own review, testing, and security assessment.

Full self-hosting is a work in progress. The repository includes local development and infrastructure helpers, but the primary supported path today is the hosted platform and devnet-oriented development.

The hosted platform is available at https://platform.solana.com and the public docs are at https://platform.solana.com/docs.

## What is in this repo?

- `apps/sdp-api`: Cloudflare Workers API, OpenAPI source, route handlers, Postgres/KV integrations
- `apps/sdp-web`: dashboard application
- `apps/sdp-docs`: public documentation site and generated API reference
- `packages/sdp-types`: shared runtime types and product constants
- `packages/sdp-api-integration`: maintainer-oriented integration test harness
- `infra`: local and deployment infrastructure helpers
- `docs/ops`: operator and maintainer notes

The supported public API areas are health, API keys, wallets, projects, issuance, payments, and compliance. Internal routes and provider-specific operational details are not part of the public surface.

## Local Development

Prerequisites:

- Node.js 22+
- pnpm 10.16+
- Git

Install dependencies:

```bash
pnpm install
```

Create a local API environment file:

```bash
cp apps/sdp-api/.dev.vars.example apps/sdp-api/.dev.vars
```

For local devnet work, set `SOLANA_RPC_URL=https://api.devnet.solana.com` in `apps/sdp-api/.dev.vars`.

Start local services:

```bash
pnpm db:postgres:up
pnpm --filter @sdp/api db:postgres:bootstrap
pnpm dev
```

Useful local URLs:

- API: http://localhost:8787
- API docs: http://localhost:8787/docs
- Dashboard: http://localhost:3000

Some provider-backed features require separate vendor credentials, such as custody providers, compliance providers, fiat ramps, dashboard auth, and integration tests.

## Checks

Common checks:

```bash
pnpm --filter @sdp/api test
pnpm --filter @sdp/api typecheck
pnpm --filter sdp-docs check:links
pnpm --filter sdp-docs build
pnpm typecheck
```

Generated artifacts should be regenerated with their owning scripts rather than hand-edited:

```bash
pnpm -C apps/sdp-api openapi:generate
pnpm -C apps/sdp-docs generate:api
pnpm -C apps/sdp-docs generate:ai
```

## Contributing

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md), [`AGENTS.md`](AGENTS.md), and the [local development notes](docs/contributing/local-development.md) before opening a pull request. Include tests for behavior changes and keep public documentation aligned with the OpenAPI source.

## License

This project is licensed under the [MIT License](LICENSE).

## Security

Report security issues using the process in [`SECURITY.md`](SECURITY.md). Do not open public issues for vulnerabilities or suspected secrets.
