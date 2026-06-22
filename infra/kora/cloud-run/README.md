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

Every Kora instance used by SDP must allow the sRFC-37 and MagicBlock private transfer programs in addition to the standard System, Token, Token-2022, Associated Token, Memo, Address Lookup Table, and Compute Budget programs:

- `TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP` — Token-ACL
- `GATEzzqxhJnsWF6vHRsgtixxSB8PaQdcqGEVTEHWiULz` — ABL / GATE
- `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2` — MagicBlock private transfer program
- `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` — MagicBlock delegation program
- `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44` — Subscriptions (recurring payments) program

This applies to the active devnet Kora surfaces:

- `dev_ci` Kora used by integration tests
- shared dev/staging Kora used by local and staging environments

The `kora-<env>` Cloud Run services (`kora-devnet` / `kora-mainnet`) mount Kora config from Secret
Manager, and those secrets are **owned by Terraform** (`infra/kora/terraform/secrets.tf`): the
`kora.<env>.toml` + `signers.<env>.toml` files in this folder are the source of truth. To roll out a
config change, edit the TOML here, then `terraform apply` for the env (which adds a new secret version)
and ship a new revision so the running service picks it up. See the repo-root README / PR
`feat/kora-deploy-via-tag` for the full mainnet cutover steps.

## Deploy

Deploys go through `.github/workflows/deploy-kora.yml`, which:

1. Reads the pinned Kora image tag from `.github/kora-image-tag`.
2. Mirrors `ghcr.io/solana-foundation/kora:<tag>` into this project's Artifact Registry
   (`us-central1-docker.pkg.dev/<project>/kora-<env>/kora:<tag>`) — Cloud Run cannot pull from ghcr.io.
3. Runs `gcloud run services update kora-<env> --image <AR>/kora:<tag>` with `KORA_<ENV>_*` env from
   Doppler.

**Bumping the deployed image:** edit `.github/kora-image-tag` to the new pinned tag and open a PR.
Merging to `main` auto-deploys **devnet then mainnet**, in that order — mainnet only runs if devnet
succeeds (the deploy job is an ordered, fail-fast matrix). A manual `workflow_dispatch` run can target
`devnet`, `mainnet`, or `both`. Each env still goes through its `devnet`/`mainnet` GitHub Environment.

If a service should be publicly reachable, allow unauthenticated invoker:

```bash
gcloud run services add-iam-policy-binding kora-devnet \
  --region us-central1 \
  --member=allUsers \
  --role=roles/run.invoker
```

## Health Check

```bash
KORA_RPC_URL=https://kora-sdp-p3bno75vpa-uc.a.run.app \
curl -s "${KORA_RPC_URL}/liveness"
```

## Optional API Key

If you want to require an API key, add `KORA_API_KEY` to the service env (from Secret Manager) and send the `x-api-key` header from clients.
