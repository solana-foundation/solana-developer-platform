# Kora Local Development

Local Kora fee payer relay for gasless Token-2022 transactions on devnet.

## Quick Start

```bash
# 1. Run setup (generates keypair, creates .env, requests airdrop)
./setup.sh

# 2. Start Kora
docker compose up

# 3. Verify it's running
curl http://localhost:8080/liveness
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` or run `./setup.sh` to auto-generate:

| Variable | Description |
|----------|-------------|
| `RPC_URL` | Solana RPC endpoint (default: devnet) |
| `SIGNER_PRIVATE_KEY` | Base58-encoded 64-byte keypair |

### Kora Settings

`kora.toml` is pre-configured for SDP Token-2022 operations:

- **Allowed programs**: System, Token, Token-2022, ATA, ALT, Compute Budget
- **Fee policy**: Free (platform-sponsored)
- **Max lamports**: 0.01 SOL per transaction
- **Rate limit**: 100 requests/second

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `http://localhost:8080` | JSON-RPC API |
| `http://localhost:8080/liveness` | Health check |
| `http://localhost:8080/metrics` | Prometheus metrics |

## JSON-RPC Methods

```bash
# Get fee payer address
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getPayerSigner","params":{}}'

# Sign and send transaction
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"signAndSendTransaction","params":{"transaction":"<base64>"}}'
```

## Funding the Fee Payer

The setup script requests an airdrop, but you can manually fund:

```bash
# Get your fee payer address from .env comments or:
source .env
node -e "const bs58=require('bs58');const k=bs58.decode('$SIGNER_PRIVATE_KEY');console.log(require('@solana/web3.js').Keypair.fromSecretKey(k).publicKey.toBase58())"

# Request airdrop (may fail due to rate limits)
solana airdrop 2 <ADDRESS> --url devnet

# Or use the faucet
# https://faucet.solana.com
```

## Troubleshooting

### "Insufficient funds" errors
Fund the fee payer address with devnet SOL.

### Redis connection errors
Ensure Redis container is healthy: `docker compose ps`

### Airdrop rate limited
Use https://faucet.solana.com or wait and retry.

## Integration with SDP API

Set these environment variables in `apps/sdp-api`:

```bash
KORA_RPC_URL=http://localhost:8080
FEE_PAYMENT_PROVIDER=kora
```

## Integration Tests

The `@sdp/api-integration` package includes Kora integration tests that verify connectivity and basic operations.

### Local Development

```bash
# Start Kora locally
pnpm kora:setup
pnpm kora:up

# Run integration tests (uses localhost:8080 by default)
pnpm --filter @sdp/api-integration test
```

### CI/GitHub Actions

Override `KORA_RPC_URL` to point to your CI Kora instance:

```bash
KORA_RPC_URL=http://kora:8080 pnpm --filter @sdp/api-integration test
```

Example GitHub Actions workflow:

```yaml
jobs:
  integration-tests:
    runs-on: ubuntu-latest
    services:
      kora:
        image: kora:latest
        ports:
          - 8080:8080
    env:
      KORA_RPC_URL: http://localhost:8080
      RUN_INTEGRATION_TESTS: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: pnpm --filter @sdp/api-integration test
```

### Test Configuration

Tests will skip automatically if Kora is not available. The configuration is controlled by:

| Variable | Default | Description |
|----------|---------|-------------|
| `KORA_RPC_URL` | `http://localhost:8080` | Kora JSON-RPC endpoint |
| `RUN_INTEGRATION_TESTS` | `true` (in integration package) | Enable integration tests |
| `KORA_API_KEY` | (none) | Optional API key for authenticated Kora |
| `KORA_TIMEOUT_MS` | `30000` | Request timeout in milliseconds |
