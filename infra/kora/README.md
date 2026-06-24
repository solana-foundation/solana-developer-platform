# Kora Devnet (Cloud Run)

We use a shared devnet Kora instance on Cloud Run so developers do **not** need a fee‑payer private key locally.

Shared service: `kora-sdp` in the `solana-developer-platform` GCP project.

## Developer Quick Start

1) Copy the example env file and fill in your keys:

```bash
cp apps/sdp-api/.dev.vars.example apps/sdp-api/.dev.vars
```

2) Run a quick health check:

```bash
pnpm kora:devnet:check
```

3) Run the Kora integration test:

```bash
pnpm kora:devnet:test
```

## Environment Variables

`apps/sdp-api/.dev.vars` should include:

- `KORA_RPC_URL` – shared devnet Kora URL
- `KORA_API_KEY` – optional (only if API key auth is enabled)
- `FEE_PAYMENT_PROVIDER=kora`
- `SOLANA_RPC_URL` – devnet RPC (Helius recommended)

## Operator Notes

Cloud Run deployment manifests and setup steps live in:

- `infra/kora/cloud-run/README.md`

## Local Docker (optional)

If you prefer local Kora, you can still use:

- `infra/kora/docker-compose.yml`
- `infra/kora/.env.example` (copy to `.env` and fill in values)

Then run:

```bash
docker compose -f infra/kora/docker-compose.yml up -d
```

## Local Kora on Surfpool

For deterministic test and CI work, keep SDP wired through the regular Kora
adapter while replacing only Kora's upstream Solana RPC with Surfpool:

```bash
pnpm install
pnpm kora:surfpool:up
```

This starts:

- Surfpool on `http://127.0.0.1:8899`
- a Kora-compatible local JSON-RPC shim on `http://127.0.0.1:18080`
- a test-only Kora memory signer funded on Surfpool

SDP still uses `FEE_PAYMENT_PROVIDER=kora` and `KORA_RPC_URL`; the shim exists
only so local deterministic tests can exercise the regular Kora adapter/client
without depending on hosted devnet Kora. To try the real Kora Docker container
instead, set `KORA_SURFPOOL_MODE=docker`. The local compose file defaults to
`ghcr.io/solana-foundation/kora:61add05`, matching the repo-pinned Kora image
in `.github/kora-image-tag`. Override `KORA_IMAGE` only when validating a
deliberate Kora server upgrade. The pinned image is amd64-only, so local Docker
runs it with `KORA_PLATFORM=linux/amd64` by default.

The local Docker image currently exposes `GET /health`; hosted Kora exposes
`GET /liveness` for Cloud Run checks.

Then run Kora-wired tests with local overrides:

```bash
SOLANA_RPC_URL=http://127.0.0.1:8899 \
SOLANA_RPC_CI_PREFERRED_PROVIDER=default \
KORA_RPC_URL=http://127.0.0.1:18080 \
FEE_PAYMENT_PROVIDER=kora \
RUN_INTEGRATION_TESTS=true \
pnpm test:integration -- src/tests/kora.test.ts
```

Or use the bundled smoke command:

```bash
pnpm kora:surfpool:test
```

Stop the local services with:

```bash
pnpm kora:surfpool:down
```

This setup is test/local-development only. Hosted devnet Kora and production
Kora continue to use their normal RPC URLs and signer infrastructure.
