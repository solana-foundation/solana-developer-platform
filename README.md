# Solana Developer Platform

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
