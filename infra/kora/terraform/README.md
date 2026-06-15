# Kora — Terraform (infra only)

Project-parameterized Terraform for the Kora paymaster infra. **Infra only** — secrets and runtime env
come from **Doppler** (see `infra/kora/` and the geyser-data `run-with-doppler.sh` pattern), never from
Terraform state.

## Sandbox → promote model

GCP resources don't move between projects; only this Terraform *definition* does. So:

```bash
# 1. Validate the whole stack in an isolated throwaway project (devnet RPC + throwaway KMS key):
terraform apply -var-file=envs/sandbox.tfvars

# 2. Promote: same module, real project, fresh prod KMS key generated in-place:
terraform apply -var-file=envs/mainnet.tfvars

# 3. Tear down the sandbox by deleting the sandbox PROJECT (KMS key rings can't be deleted otherwise).
```

`env` (sandbox|devnet|mainnet) drives every resource name as `kora-<env>-*`, so the three targets never
collide. Keep state separate per target (see the GCS backend note in `versions.tf`).

## Build status (incremental, reviewed per resource group)

- [x] **Slice 1 — service accounts, IAM, KMS** (`iam.tf`, `kms.tf`)
- [x] **Slice 2 — Cloud Run service shell** (`cloud_run.tf`) — image+env owned by the deploy pipeline
      (`doppler run -- gcloud run deploy`), config baked into the image, no Secret Manager.
- [x] **Slice 3 — Memorystore Redis + Serverless VPC connector** (`redis.tf`); Cloud Run egresses to
      Redis via the connector. `redis_url` output → `KORA_REDIS_URL` in Doppler.
- [x] **Slice 4 — Artifact Registry + Workload Identity Federation** (`artifact_registry.tf`, `wif.tf`);
      per-env Docker repo + keyless GitHub OIDC → deployer SA impersonation.

## After Slice 1 applies

1. `kms_key_version_name` output → set as `KORA_GCP_KMS_KEY_NAME` in the Doppler config for that env.
2. Derive the base58 pubkey (see the `kms_key_version_name` output for the exact `gcloud` command) →
   set as `KORA_GCP_KMS_PUBLIC_KEY` in Doppler, and **fund that Solana address**.

## Validation

`fmt` + `validate` pass clean (Terraform v1.15.6, google `~>6.0`). Also **applied live** end-to-end
(2026-06-15) to `trading-prod-494016` with `env=sandbox`: all 16 resources created, Cloud Run returns
HTTP 200, KMS Ed25519 key derives a valid Solana address, Redis READY. The live apply caught one fix
now in `redis.tf` — the VPC connector requires `min_instances`/`max_instances` under google `~>6.0`.

## Prerequisites / open items

- **Sandbox project**: `sdp-kora-sandbox` created (project-creation rights confirmed). **BUT billing
  can't be linked** — the EU billing account (`0184B7-0A4E5C-26D8AE`) hit its project quota, so paid APIs
  can't be enabled and `plan`/`apply` can't run there yet. Blocked on a billing quota increase / freed
  slot / alternate billing account.
- **State backend**: no GCS tfstate bucket exists yet; `versions.tf` defaults to local state for review.
- **KMS HSM**: `kms_protection_level` defaults to SOFTWARE; confirm EC_SIGN_ED25519 is offered at HSM
  level before hardening mainnet to HSM.
