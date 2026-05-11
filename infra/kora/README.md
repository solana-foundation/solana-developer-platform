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
