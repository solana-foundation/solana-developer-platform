# Maintainer Documentation Index

> **Maintainers only.** External contributors should use the main [`README.md`](../../README.md) and [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

This directory contains the operational guidance for releases, Cloud Run deployments, runtime configuration, and CI/CD.

## Documentation

### [Release Operations](./release-operations.md)

How the API moves from `main` to the dev and production Cloud Run services, how release commits and tags relate to deployment, and how to roll back safely.

Read this before deploying, approving a release, troubleshooting a failed Cloud Run rollout, or rolling production back.

### [Doppler Secrets Operations](./doppler-secrets.md)

How Doppler is used for local development, secret-aware CI, and Vercel configuration, plus the boundary between Doppler and the API's GCP runtime configuration.

Read this when setting up local development, configuring CI, rotating secrets, or investigating environment drift.

## Common Tasks

### Deploy a change to dev

1. Merge the change to `main`.
2. Follow the `Deploy sdp-api to Cloud Run (dev)` workflow.
3. Verify `https://api-dev.solana.com/health` and the affected API behavior.

### Publish a production release

1. Follow [Release Operations](./release-operations.md).
2. Review and approve the generated release pull request when it is ready.
3. Monitor both the production Cloud Run deployment and the release publication after it merges.

### Access secrets locally

1. Follow [Doppler Secrets Operations](./doppler-secrets.md).
2. Run `doppler login`, select a personal config cloned from `dev`, and use the root `pnpm` commands.

### Troubleshoot a failed deployment

1. Inspect the failing GitHub Actions step.
2. Inspect the Cloud Run service or job execution in the matching GCP project.
3. Use [Release Operations](./release-operations.md) for deployment and rollback failures.
4. Use [Doppler Secrets Operations](./doppler-secrets.md) for CI or local-secret failures.

## Quick Reference

### Hosted API targets

| Environment | GCP project | Service | Cron job | Trigger |
| --- | --- | --- | --- | --- |
| Dev | `solana-developer-platform-dev` | `sdp-dev-api-public` | `sdp-dev-api-public-cron` | Relevant push to `main`, or manual dispatch |
| Production | `solana-developer-platform` | `sdp-prod-api-public` | `sdp-prod-api-public-cron` | Release commit on `main`, or manual dispatch of an existing SHA image from `main` |

The migration jobs are `sdp-dev-api-public-migrate` and `sdp-prod-api-public-migrate`.

### Doppler configs

| Config | Purpose |
| --- | --- |
| `dev` | Team development and personal-config source |
| `dev_ci` | Secret-aware GitHub Actions jobs |
| `stg` | Preview/staging web and docs configuration |
| `prd` | Production web/docs configuration and operator access |

Cloud Run image deployment does not fetch Doppler. The API service and jobs receive runtime configuration from GCP-managed service/job configuration and secret references.

### Required GitHub configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `DEPLOY_WIF_PROVIDER` | Variable | Google Workload Identity provider used by Cloud Run deploy workflows |
| `DEPLOY_SA` | Variable | Google service account used by Cloud Run deploy workflows |
| `DOPPLER_TOKEN_CI` | Repository secret | Read access to `dev_ci` for secret-aware CI |
| `RELEASE_APP_ID` | Repository secret | GitHub App used by release automation |
| `RELEASE_APP_PRIVATE_KEY` | Repository secret | GitHub App private key used by release automation |

The production deploy job uses the `production` GitHub environment. The generated release pull request is the release approval gate.

## Support

- Deployment and rollback: [Release Operations](./release-operations.md)
- Secrets and environment configuration: [Doppler Secrets Operations](./doppler-secrets.md)
- Repository-level problems: open a GitHub issue or contact the maintainers

**Last updated:** July 2026
