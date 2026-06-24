# 🔧 @sdp-api-integration

**Internal package** — End-to-end integration test suite for the SDP API against live Solana devnet infrastructure.

## What is this?

This package contains integration tests that:

- Test API functionality against real Solana devnet
- Use live custody providers (Privy, Coinbase CDP, Turnkey, etc.)
- Verify token operations (mint, freeze, transfer)
- Validate payment flows with compliance screening
- Test wallet creation and management

**Not for external use** — these are maintainer-only tests.

## For SDP Team Members

### Prerequisites

- **Privy account** with devnet credentials (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`)
- **Kora instance** running locally or accessible (`KORA_RPC_URL`)
- **Funded Solana devnet account** (for fee payments)
- **SDP API running** (local or remote)

### Running Tests

```bash
# All integration tests
pnpm test:integration

# Kora smoke test only
pnpm kora:devnet:test

# Specific test file
pnpm --filter @sdp/api-integration test src/tests/mint.test.ts

# With specific custody provider
SIGNING_PROVIDER=privy pnpm test:integration

# Verbose output
pnpm test:integration -- --verbose
```

**Notes:**
- Kora connectivity and fee payer balance are validated up-front — the suite fails fast if Kora is unreachable or underfunded.
- The suite initializes a Privy signer for the integration org and uses DB-backed default signer resolution.

### Environment Variables

Use Doppler (team members) or export manually:

**Required:**

- `SOLANA_RPC_URL` — Example: `https://api.devnet.solana.com`
- `KORA_RPC_URL` — Example: `https://your-kora-devnet-instance.us-central1.run.app`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`

**Optional:**

- `KORA_API_KEY` — Only required if your Kora endpoint requires API key auth.
- `KORA_MIN_BALANCE_LAMPORTS` — Preflight threshold for the Kora fee payer balance check.

```bash
# Solana RPC
SOLANA_RPC_URL=https://api.devnet.solana.com

# Fee-payer service (devnet)
KORA_RPC_URL=https://your-kora-devnet-instance.us-central1.run.app
# KORA_API_KEY=...

# Privy signer (default)
PRIVY_APP_ID=<your-privy-app-id>
PRIVY_APP_SECRET=<your-privy-secret>

# Or other custody providers
SIGNING_PROVIDER=coinbase_cdp
COINBASE_CDP_API_KEY_ID=...
COINBASE_CDP_API_KEY_SECRET=...
```

### Test Structure

```
src/
├── helpers/
│   ├── api-types.ts       # API response type helpers
│   ├── env.ts             # Environment variable loading
│   ├── integration.ts     # Shared test utilities
│   └── preflight.ts       # Kora/env preflight checks
├── tests/
│   ├── api-keys-flow.test.ts
│   ├── api-keys-rotation.test.ts
│   ├── burn.test.ts
│   ├── custody-local.test.ts
│   ├── deploy.test.ts
│   ├── freeze.test.ts
│   ├── issuance-endpoints.test.ts
│   ├── kora-flow.test.ts
│   ├── kora.test.ts
│   ├── mint.test.ts
│   ├── mosaic-abl.test.ts
│   ├── mosaic-templates.test.ts
│   ├── mosaic-token-acl.test.ts
│   ├── payments-wallet-scope.test.ts
│   └── token2022.test.ts
└── setup.ts
```

### Writing Integration Tests

```typescript
// src/tests/example.test.ts
import { describe, it, expect } from "vitest";
import { getEnv } from "../helpers/env";

describe("Example", () => {
  it("reads env", () => {
    const env = getEnv();
    expect(env.SOLANA_RPC_URL).toBeDefined();
  });
});
```

### Best Practices

- **Use fixtures for test data** — Don't hardcode addresses/IDs
- **Clean up resources** — Fund test wallets, then drain them after tests
- **Document custody provider requirements** — Note which tests need Privy vs CDP, etc.
- **Keep tests isolated** — Each test should be runnable independently
- **Use reasonable timeouts** — Devnet transactions can be slow

## Custody Provider Test Coverage

| Provider | Status | Notes |
|---|---|---|
| **Privy** | ✅ Full | Fully tested, default signer |
| **Coinbase CDP** | ✅ Full | Requires business account |
| **Turnkey** | ✅ Partial | Requires API key |
| **Fireblocks** | ⚠️ Partial | Requires business account |
| **Para** | ⚠️ Partial | Requires API key |
| **Kora** | ✅ Full | Local devnet fee-payer |

## Troubleshooting

### "PRIVY_APP_ID not set"
```bash
export PRIVY_APP_ID=your_app_id
export PRIVY_APP_SECRET=your_secret
```

### "Kora is not responding"
```bash
# Ensure Kora is running
pnpm kora:up

# Check connectivity
curl http://127.0.0.1:8080/health
```

### Run regular Kora wiring against Surfpool

For local deterministic Kora-wired smoke coverage, use the Kora-compatible shim
with Surfpool as its upstream Solana RPC:

```bash
pnpm kora:surfpool:up
pnpm kora:surfpool:test
pnpm kora:surfpool:down
```

The test command still runs SDP through `FEE_PAYMENT_PROVIDER=kora` and
`KORA_RPC_URL=http://127.0.0.1:18080`; only the JSON-RPC server behind that URL
is local test infrastructure. It signs with a test-only fee payer and submits to
Surfpool at `SOLANA_RPC_URL=http://127.0.0.1:8899`.

### "Devnet airdrop failed"
- Airdrop limit is ~2 SOL per request
- Wait a few seconds between airdrop requests
- Use a fresh keypair if rate limited

### "Transaction timed out"
- Devnet can be slow; increase test timeout:
  ```typescript
  it("test", { timeout: 30000 }, async () => {
    // ...
  });
  ```

## Contributing

- Add tests for new API features
- Update this README if adding new test modules
- Ensure tests are isolated and repeatable
- Document which custody providers are required
- Clean up test wallets/accounts after tests

## Support

- **Test failures**: Check logs and Solana devnet status
- **Custody provider issues**: Refer to provider's devnet docs
