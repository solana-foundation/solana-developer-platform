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

- an embedded Surfpool `Surfnet` with a dynamically allocated local RPC URL
- a Kora-compatible local JSON-RPC shim on `http://127.0.0.1:18080`
- a test-only Kora memory signer funded on Surfpool

SDP still uses `FEE_PAYMENT_PROVIDER=kora` and `KORA_RPC_URL`; the shim exists
only so local deterministic tests can exercise the regular Kora adapter/client
without depending on hosted devnet Kora. Embedded Surfnet selects the same
managed Solana RPC provider used by the integration test runner, honoring
`SOLANA_RPC_CI_PREFERRED_PROVIDER`, and passes it to Surfpool as
`SURFPOOL_REMOTE_RPC_URL`. Set `SURFPOOL_REMOTE_RPC_URL` directly to override
that selection, or omit all managed RPC env vars to run embedded Surfpool
offline. To use the Surfpool CLI sidecar instead of embedded Surfnet, set
`KORA_SURFPOOL_RUNTIME=cli`. To try the real Kora Docker container instead of
the shim, set `KORA_SURFPOOL_MODE=docker`. When running under Doppler, the
harness ignores Doppler's hosted `KORA_RPC_URL` and binds local Kora-compatible
traffic to `http://127.0.0.1:18080`; use `KORA_SURFPOOL_KORA_RPC_URL` to change
that local endpoint.

The local compose file defaults to
`ghcr.io/solana-foundation/kora:61add05`, matching the repo-pinned Kora image
in `.github/kora-image-tag`. Override `KORA_IMAGE` only when validating a
deliberate Kora server upgrade. The pinned image is amd64-only, so local Docker
runs it with `KORA_PLATFORM=linux/amd64` by default.

The local Docker image currently exposes `GET /health`; hosted Kora exposes
`GET /liveness` for Cloud Run checks.

Then run Kora-wired tests with local overrides:

```bash
source .secrets/kora-surfpool/runtime.env
SOLANA_RPC_CI_PREFERRED_PROVIDER=default \
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
