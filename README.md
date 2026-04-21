# Solana Developer Platform

Solana Developer Platform is an API, dashboard, and docs workspace for building Solana-based issuance, payments, wallet, and compliance workflows.

SDP is **devnet-only for now**. Mainnet support is not part of the public getting-started path yet.

Self-hosting and deployment guides are coming.

## Workspace

- `apps/sdp-api`: Cloudflare Workers API, OpenAPI source, route handlers, and data integrations
- `apps/sdp-web`: dashboard application
- `apps/sdp-docs`: public documentation site and generated API reference
- `packages/sdp-types`: shared runtime types and product constants

## Providers

SDP requires credentials from the providers you enable. Provider accounts, API keys, wallets, policies, and compliance settings are managed with those providers directly.

RPC:

- Solana devnet RPC
- Alchemy
- Helius
- QuickNode
- Triton

Custody and wallets:

- Enterprise custody and institutional wallets: Fireblocks, DFNS, Anchorage
- Embedded or server-wallet infrastructure: Privy, Coinbase CDP, Para, Turnkey
- Local signer: development only

Compliance:

- Range
- Elliptic
- TRM Labs
- Chainalysis

Payment ramps:

- MoonPay
- Lightspark Grid
- BVNK

## Local Development

Prerequisites:

- Node `>=20`
- `pnpm` `10.15.1`
- Provider credentials for the integrations you want to exercise
- Doppler access or equivalent local environment variables

Install dependencies:

```bash
pnpm install
```

Run the development stack:

```bash
pnpm dev
```

Example API environment values are documented in `apps/sdp-api/.dev.vars.example`.

## Checks

```bash
pnpm typecheck
pnpm --filter @sdp/api test
pnpm --filter sdp-docs build
```

## Community

- [License](./LICENSE)
- [Security policy](./SECURITY.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Code owners](./.github/CODEOWNERS)
