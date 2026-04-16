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

# Specific test file
pnpm --filter @sdp/api-integration test src/tests/wallets.test.ts

# With specific custody provider
SIGNING_PROVIDER=privy pnpm test:integration

# Verbose output
pnpm test:integration -- --verbose
```

### Environment Variables

Create `.env.local` or use Doppler:

```bash
# Solana RPC
SOLANA_RPC_URL=https://api.devnet.solana.com

# Fee-payer service
KORA_RPC_URL=http://127.0.0.1:8080
SIGNER_PRIVATE_KEY=<base58-devnet-keypair>

# Privy signer (default)
SIGNING_PROVIDER=privy
PRIVY_APP_ID=<your-privy-app-id>
PRIVY_APP_SECRET=<your-privy-secret>

# Or other custody providers
SIGNING_PROVIDER=coinbase_cdp
COINBASE_CDP_API_KEY_ID=...
COINBASE_CDP_API_KEY_SECRET=...
```

### Test Structure

```
src/tests/
├── wallets.test.ts        # Wallet creation/management
├── issuance.test.ts       # Token minting and operations
├── payments.test.ts       # Fund transfers
├── compliance.test.ts     # AML/KYC screening
└── support/
    ├── fixtures.ts        # Test data factories
    └── helpers.ts         # Test utilities
```

### Writing Integration Tests

```typescript
// src/tests/example.test.ts
import { describe, it, expect } from "vitest";
import { createWallet, fundAccount } from "../support/helpers";

describe("Wallet Operations", () => {
  it("creates a wallet with Privy", async () => {
    const wallet = await createWallet("privy");
    
    expect(wallet.id).toMatch(/^wal_/);
    expect(wallet.address).toBeDefined();
    expect(wallet.provider).toBe("privy");
  });

  it("funds a wallet via Kora", async () => {
    const wallet = await createWallet("privy");
    
    const txid = await fundAccount(wallet.address, 1_000_000); // 0.001 SOL
    
    expect(txid).toBeDefined();
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
- **Questions**: Internal Slack (team channel)
