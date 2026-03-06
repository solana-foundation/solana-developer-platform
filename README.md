# Solana Developer Platform

## Release Operations

This repo uses a two-environment release model for the API:

- `main` deploys the API to `dev`
- semver tags `vX.Y.Z` deploy the API to `production`
- legacy tags in the form `solana-developer-platform-vX.Y.Z` are still accepted for rollback compatibility
- production rollback is a manual redeploy of a previous semver tag

### GitHub Setup

Configure these before relying on the release flow:

- GitHub environments: `dev` and `production`
- GitHub secrets for both environments:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
- Repository secret:
  - `RELEASE_PLEASE_TOKEN`

`RELEASE_PLEASE_TOKEN` must be a PAT or GitHub App token with at least `contents: write` and `pull-requests: write`. The default `GITHUB_TOKEN` is not sufficient if you want the tag created by Release Please to trigger the production deploy workflow.

### Release Flow

1. Open PRs against `main` with semantic titles such as `feat: ...`, `fix: ...`, or `perf: ...`.
2. Merge changes into `main`.
3. Release Please opens or updates the release PR.
4. Merge the release PR to create a Git tag like `v1.2.3`.
5. The tag push triggers the production deploy workflow automatically.

### Rollback

To roll back production:

1. Open GitHub Actions.
2. Run `Deploy SDP API`.
3. Set `environment=production`.
4. Set `ref` to the previously released tag, for example `v1.2.2`.
   Legacy release tags like `solana-developer-platform-v0.2.0` are also accepted.
5. Leave `run_migrations=false` unless you explicitly need to run migrations.

Important: code rollback is supported, but schema rollback is not automated. Production migrations should remain backward-compatible with the previously deployed application version.

## Integration Tests (Devnet)

The integration test suite runs against Solana **devnet** and signs real transactions using the **Privy custody** provider.

### Prereqs

- Node `>=20`
- `pnpm` (repo pins `pnpm@10.15.1`)

### Required Environment Variables

Integration tests require:

- `SOLANA_RPC_URL`
  - Example: `https://api.devnet.solana.com`
- `KORA_RPC_URL`
  - Example: `https://kora-devnet-315956366746.us-central1.run.app`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`

Optional (recommended):

- `KORA_API_KEY`
  - Only required if your Kora endpoint needs it.
- `KORA_MIN_BALANCE_LAMPORTS`
  - Optional preflight threshold for the Kora fee payer balance.

### Run Integration Tests

From the repo root:

```bash
export SOLANA_RPC_URL="https://api.devnet.solana.com"
export PRIVY_APP_ID="..."
export PRIVY_APP_SECRET="..."

export KORA_RPC_URL="https://kora-devnet-315956366746.us-central1.run.app"
# export KORA_API_KEY="..."

pnpm test:integration
```

Notes:

- The suite includes Kora tests. Kora connectivity/funding is validated up-front (fail-fast).
- The suite initializes a Privy signer for the integration org and uses DB-backed default signer resolution.
- If you want to run only the Kora smoke test: `pnpm kora:devnet:test`.
