# Kora Cloud Run (Devnet)

This folder contains the Cloud Run manifests and operator notes for the shared devnet Kora instance.

## Devnet Service

- Project: `solana-developer-platform`
- Service: `kora-sdp`
- Region: `us-central1`
- URL: `https://kora-sdp-p3bno75vpa-uc.a.run.app`
- Image: `us-central1-docker.pkg.dev/analytics-324114/kora-remote/solana-foundation/kora@sha256:bb6a1a11cdf5edcd34060619ebefbe9ea54419d7bb84de5667f36b31f1489f3d`

## Required Secrets (Secret Manager)

Create these secrets before deploy:

- `kora-sdp-config` → `kora.devnet.toml`
- `kora-sdp-signers` → `signers.devnet.toml`
- `kora-sdp-signer-private-key` → base58 keypair
- `kora-sdp-rpc-url` → devnet RPC URL (Helius or equivalent)

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
gcloud config set project solana-developer-platform

gcloud secrets versions add kora-sdp-config \
  --data-file=infra/kora/cloud-run/kora.devnet.toml

gcloud run services update kora-sdp \
  --region us-central1 \
  --update-env-vars KORA_CONFIG_VERSION=$(date +%s)
```

For mainnet, mirror the same `allowed_programs` entries in the config payload backing `kora-mainnet-config`, then roll out `kora-mainnet`.

## Deploy

```bash
gcloud config set project solana-developer-platform
gcloud run services update kora-sdp --region us-central1
```

If the service should be publicly reachable, allow unauthenticated invoker:

```bash
gcloud run services add-iam-policy-binding kora-sdp \
  --region us-central1 \
  --member=allUsers \
  --role=roles/run.invoker
```

## Health Check

```bash
KORA_RPC_URL=https://kora-sdp-p3bno75vpa-uc.a.run.app \
curl -s "${KORA_RPC_URL}/liveness"
```

## Mainnet (later)

`kora.mainnet.yaml` mirrors the devnet manifest and expects the same secret names with `kora-mainnet-*`.

## Optional API Key

If you want to require an API key, add `KORA_API_KEY` to the service env (from Secret Manager) and send the `x-api-key` header from clients.
