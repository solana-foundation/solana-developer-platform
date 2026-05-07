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

## Required Allowed Programs

Every Kora instance used by SDP must allow the sRFC-37 programs in addition to the standard System, Token, Token-2022, Associated Token, Memo, Address Lookup Table, and Compute Budget programs:

- `TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP` — Token-ACL
- `GATEzzqxhJnsWF6vHRsgtixxSB8PaQdcqGEVTEHWiULz` — ABL / GATE

This applies to:

- `dev_ci` Kora used by integration tests
- shared dev/staging Kora used by local and staging environments
- production Kora before denylist token operations run on mainnet

The Cloud Run services mount Kora config from Secret Manager, so a checked-in TOML change must also be uploaded to the matching secret and rolled out to the running service. For the shared devnet service:

```bash
gcloud secrets versions add kora-devnet-config \
  --data-file=infra/kora/cloud-run/kora.devnet.toml

gcloud run services replace infra/kora/cloud-run/kora.devnet.yaml \
  --region us-central1
```

For mainnet, mirror the same `allowed_programs` entries in the config payload backing `kora-mainnet-config`, then roll out `kora-mainnet`.

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
