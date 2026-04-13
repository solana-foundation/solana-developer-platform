# Kora Cloud Run (Devnet)

This folder contains the Cloud Run manifests and operator notes for the shared devnet Kora instance.

## Devnet Service

- Service: `kora-devnet`
- Region: `us-central1`
- Image: `us-central1-docker.pkg.dev/YOUR_GCP_PROJECT_ID/kora-remote/solana-foundation/kora:latest`

## Required Secrets (Secret Manager)

Create these secrets before deploy:

- `kora-devnet-config` → `kora.devnet.toml`
- `kora-devnet-signers` → `signers.devnet.toml`
- `kora-devnet-signer-private-key` → base58 keypair
- `kora-devnet-rpc-url` → devnet RPC URL (Helius or equivalent)

## Deploy

```bash
gcloud run services replace infra/kora/cloud-run/kora.devnet.yaml --region us-central1
```

If the service should be publicly reachable, allow unauthenticated invoker:

```bash
gcloud run services add-iam-policy-binding kora-devnet \
  --region us-central1 \
  --member=allUsers \
  --role=roles/run.invoker
```

## Health Check

```bash
KORA_RPC_URL=https://your-kora-devnet-instance.us-central1.run.app \
curl -s "${KORA_RPC_URL}/liveness"
```

## Mainnet (later)

`kora.mainnet.yaml` mirrors the devnet manifest and expects the same secret names with `kora-mainnet-*`.

## Optional API Key

If you want to require an API key, add `KORA_API_KEY` to the service env (from Secret Manager) and send the `x-api-key` header from clients.
