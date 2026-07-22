# Release Operations

> **Maintainers only.** This guide covers releases, Cloud Run deployment, and rollback for the hosted SDP API.

## Deployment Model

| Event | Target | Result |
| --- | --- | --- |
| Relevant push to `main` | Dev | Builds a SHA-tagged image, runs migrations, updates the dev service, and updates the dev cron job |
| `chore(main): release X.Y.Z` commit on `main` | Production | Builds version- and SHA-tagged images, runs migrations, updates the production service, and updates the production cron job |
| Manual dev workflow dispatch | Dev | Rebuilds and deploys the selected workflow revision |
| Manual production workflow dispatch from `main` | Production | Resolves an existing 40-character Git SHA image tag and redeploys its immutable digest without running migrations |
| `vX.Y.Z` tag | Release artifacts | Publishes the GitHub release and triggers release-image/checksum workflows; it does not deploy the API |

The hosted API runs as a Node.js container on Cloud Run. Dev and production use separate GCP projects, Artifact Registry repositories, services, migration jobs, and cron jobs.

## GitHub and GCP Setup

### GitHub environments

The `production` environment is attached to the production deployment job. Configure required reviewers there only if production needs an approval in addition to the generated release pull request.

### GitHub variables

Configure these deployment values as repository variables so the dev workflow can read them. The production environment may override them when it uses a different identity:

- `DEPLOY_WIF_PROVIDER` — Google Workload Identity provider
- `DEPLOY_SA` — Google service account used by the deployment workflows

The deploy identity needs the least-privilege permissions required to push to the target Artifact Registry repository and update/execute the named Cloud Run services and jobs.

Release automation also reads these repository variables:

- `TRANSLATION_AGENT_URL` — required when a release has missing UI translations
- `TRANSLATION_AGENT_MODEL` — optional model name included in the release summary
- `TRANSLATION_AGENT_MAX_KEYS` — optional translation budget; defaults to `500`
- `TRANSLATION_AGENT_BATCH_SIZE` — optional request batch size; defaults to `50`
- `TRANSLATION_AGENT_MAX_RETRIES` — optional retry count; defaults to `2`

### Repository secrets

- `DOPPLER_TOKEN_CI` — Doppler token for secret-aware CI
- `RELEASE_APP_ID` — GitHub App ID used by release automation
- `RELEASE_APP_PRIVATE_KEY` — corresponding GitHub App private key
- `TRANSLATION_AGENT_USERNAME` and `TRANSLATION_AGENT_PASSWORD` — HTTP Basic credentials required when a release has missing UI translations

The release GitHub App needs `contents: write` and `pull_requests: write`, and it must be allowed to maintain the generated release branch and enable auto-merge.

### Cloud Run resources

| Environment | Project | Artifact repository | Service | Migration job | Cron job |
| --- | --- | --- | --- | --- | --- |
| Dev | `solana-developer-platform-dev` | `sdp-dev` | `sdp-dev-api-public` | `sdp-dev-api-public-migrate` | `sdp-dev-api-public-cron` |
| Production | `solana-developer-platform` | `sdp-prod` | `sdp-prod-api-public` | `sdp-prod-api-public-migrate` | `sdp-prod-api-public-cron` |

All resources currently use `us-central1`.

The workflows update images only. Runtime environment variables, Secret Manager references, service accounts, networking, scaling, and scheduler configuration must already exist on the Cloud Run resources.

Configure `PUBLIC_API_ORIGIN` directly on each API service before deployment:

| Environment | Required value |
| --- | --- |
| Dev | `https://api-dev.solana.com` |
| Production | `https://api.solana.com` |

This value is mandatory for hosted services because token deployment embeds metadata URLs permanently on-chain. Do not rely solely on request-derived proxy headers for those URLs. The image-only workflows preserve this service configuration and do not create or update it.

## Normal Change Flow

### 1. Merge a feature pull request

Use a conventional pull request title such as `feat:`, `fix:`, `perf:`, `docs:`, or `refactor:`. Release automation uses the merged history to calculate the next version and changelog.

When the pull request merges, the dev workflow runs if a relevant API, package, workspace, lockfile, or workflow path changed:

[`.github/workflows/deploy-sdp-api-gcp.yml`](../../.github/workflows/deploy-sdp-api-gcp.yml)

The workflow:

1. Authenticates to GCP through Workload Identity Federation.
2. Builds the API Docker image and pushes a `GITHUB_SHA` tag.
3. Updates and executes the migration job.
4. Updates the API service.
5. Updates the cron job image.

Verify the dev deployment before approving a release:

```bash
curl --fail-with-body https://api-dev.solana.com/health
```

Also exercise the affected authenticated, webhook, or provider flow; `/health` only proves that the HTTP process is reachable.

### 2. Review the generated release pull request

The Release Flow workflow maintains `codex/release-main` and opens a pull request titled `chore(main): release X.Y.Z`. It updates:

- `package.json`
- `.github/.release-please-manifest.json`
- `CHANGELOG.md`
- missing UI translations, when applicable

Auto-merge is enabled, but branch protection still requires review approval and required checks. The release pull request is the human release gate.

### 3. Deploy and publish production

Merging the release pull request creates a `chore(main): release X.Y.Z` commit on `main`. That push starts two independent operations:

- [`deploy-sdp-api-gcp-prod.yml`](../../.github/workflows/deploy-sdp-api-gcp-prod.yml) deploys the production API.
- [`release-please.yml`](../../.github/workflows/release-please.yml) creates the `vX.Y.Z` tag and GitHub release.

The production deploy workflow:

1. Authenticates to the production GCP project.
2. Builds the API image and pushes both `X.Y.Z` and `GITHUB_SHA` tags.
3. Resolves the SHA tag to an immutable image digest.
4. Updates and executes `sdp-prod-api-public-migrate`.
5. Captures the current service traffic and cron image for rollback.
6. Deploys a no-traffic candidate revision and verifies its immutable digest.
7. Polls the candidate's `/health/ready` endpoint until Postgres and Redis are ready.
8. Sends production traffic to the candidate, verifies `https://api.solana.com/health/ready`, and updates `sdp-prod-api-public-cron` to the same digest.

If production promotion or the cron update fails, the workflow attempts to restore the previous service traffic and cron image. Treat any incomplete automatic rollback as an incident and reconcile both resources immediately.

Do not treat the GitHub release publication as proof that the Cloud Run rollout succeeded; monitor both workflows.

### 4. Verify production

Check:

1. The production GitHub Actions job completed successfully.
2. The migration job execution succeeded.
3. The candidate and canonical `/health/ready` checks passed for the deployed revision, including Postgres and Redis.
4. The cron job references the same release image as the service.
5. `https://api.solana.com/health` succeeds.
6. Cloud Run error rate, latency, logs, and Sentry remain healthy.
7. At least one representative authenticated API flow succeeds.

## Manual Deployment

Manual dispatch of the production workflow redeploys an image that already exists in Artifact Registry. Run the workflow from `main` and provide:

- `image_sha` — the lowercase 40-character Git SHA tag attached to the intended image

Before dispatch, confirm that the SHA came from a successful, trusted production release workflow and that the resolved digest matches the expected release or incident record. The presence of a tag in Artifact Registry is not sufficient provenance on its own.

The workflow validates the SHA, resolves its tag to an immutable digest, verifies a no-traffic candidate, and then promotes the API service and cron job under the same rollback guard used by a normal production release. It does not check out or rebuild source, and it never updates or executes the migration job during a manual deployment.

## Production Rollback

1. Identify the last healthy release's full Git SHA from a successful, trusted production release workflow. Confirm its recorded digest and `sdp-api-public:<sha>` image still match in the production Artifact Registry repository.
2. Open `Deploy sdp-api to Cloud Run (prod)` in GitHub Actions and choose **Run workflow** from `main`.
3. Enter the full SHA as `image_sha`.
4. Approve the `production` environment gate if configured.
5. Follow the run until both the service and cron job reference the resolved digest.
6. Repeat the production verification checklist and record the SHA, digest, reason, and operator in the incident timeline.

Database schema rollback is not automated. If the selected image is incompatible with the current schema, stop and prepare a forward fix instead of improvising a destructive migration.

### Schema compatibility

Migrations must remain backward-compatible across the rollback window:

- Add columns or tables before code depends on them.
- Avoid deleting or renaming data that the previous release reads.
- Separate destructive cleanup into a later release after rollback support expires.
- Test the previous application image against the migrated schema when a change is high risk.

## One-time Cloudflare teardown

This repository no longer contains a Cloudflare runtime or deployment path. The steps below retire only the SDP API Worker runtime resources.

> **Preserve shared DNS.** The authoritative `solana.com` Cloudflare DNS zone, its nameservers, and unrelated records are shared infrastructure and are explicitly out of scope. Do not delete the zone or change its nameservers. Keep the API DNS records pointing at the current GCP ingress; removing an API Worker route must not remove the underlying DNS record.

After this change is merged, a maintainer with access to every historical Cloudflare account and environment must complete the teardown:

1. Open a tracked change with an owner, rollback window, and approvals. Inventory every account and environment, including any legacy QA account. Resolve whether the Workers named `sdp-api`, `sdp-api-dev`, or `sdp-api-production` still exist and enumerate their scheduled triggers, custom-domain routes, `workers.dev` exposure, Hyperdrive configurations, API-key/rate-limit/cache/session KV namespaces, and credentials. Mark every dependency as dedicated or shared before changing it.
2. Verify both Cloud Run environments, migrations, cron jobs, certificates, `https://api.solana.com/health/ready`, `https://api-dev.solana.com/health/ready`, and representative authenticated flows. Confirm the API DNS records resolve to the current GCP ingress, and document any Worker route still associated with those hostnames without changing the DNS records. Record the current production SHA and immutable service/cron digest.
3. Exercise the production rollback before the old platform is removed: deploy a known schema-compatible image from a successful, trusted production release, verify it, then redeploy the recorded current SHA. Do not continue until the service and cron job are healthy and restored to the recorded current digest.
4. Observe the legacy Worker routes and direct `workers.dev` endpoints for the agreed rollback window. That window must cover the longest relevant DNS/client cache TTL plus the team's monitoring period. Confirm that no application traffic reaches the Workers; do not delete them before this observation completes.
5. Remove only the SDP API Worker triggers, custom-domain routes, and `workers.dev` exposure, then delete the inventoried API Workers. Preserve the shared DNS zone, nameservers, API DNS records, and unrelated Cloudflare resources.
6. After a fresh dependency and retention check, delete only the dedicated Hyperdrive configurations and API-key, rate-limit, cache, and session KV namespaces. Those namespaces held transient state; Postgres remains authoritative, so no normal data migration is required.
7. Remove the retired `CLOUDFLARE_*` resource IDs and credentials from Doppler and GitHub. Revoke a token only if the inventory proves it was dedicated to the API Workers; otherwise remove its API Worker access or rotate it with the owners of its remaining consumers. If no external consumer remains, also remove the obsolete production `DOPPLER_TOKEN` secret, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, and `CLOUD_SQL_INSTANCE_CONNECTION_NAME` variables, and unused `dev` or `release-production` GitHub environments. Preserve the `production` environment, `DEPLOY_WIF_PROVIDER`, `DEPLOY_SA`, and `DOPPLER_TOKEN_CI`.
8. Re-run the GCP and application checks, confirm no retired Worker route or runtime remains and no traffic reaches it, and verify that the service and cron job still reference the intended production digest. Record every resource identifier, action, timestamp, operator, and verification artifact in the access-controlled change record.

Do not copy old resource IDs into this repository. Resolve deletion targets from the secret manager and provider dashboards immediately before each action, and store credentials and other sensitive evidence in the approved secret-bearing system.

## Troubleshooting

### GCP authentication fails

Verify `DEPLOY_WIF_PROVIDER` and `DEPLOY_SA`, the GitHub OIDC subject conditions, and the deploy service account's permissions in the target project.

### Image push fails

Verify the Artifact Registry repository exists in `us-central1`, Docker authentication completed, and the deploy identity can upload artifacts.

### Migration job fails

Inspect the Cloud Run job execution and application logs. Do not deploy the service past a failed required migration. Fix forward when possible; do not improvise a schema rollback in the workflow.

### Service update fails after migrations

In production, a candidate that fails readiness receives no production traffic and leaves the cron image unchanged. Inspect startup logs, required environment and secret references, Cloud SQL/Redis connectivity, and health checks. If promotion fails later, verify that the workflow restored both the previous traffic split and cron image; escalate immediately if either rollback was incomplete. In dev, inspect the Cloud Run rollout directly and restore the previous revision when the backward-compatible schema permits it.

### Cron job and service use different images

Resolve each resource's image reference, choose the intended release SHA/digest, and update the stale resource. Do not leave reconciliation running on code that is incompatible with the serving revision.

## References

- [Dev Cloud Run workflow](../../.github/workflows/deploy-sdp-api-gcp.yml)
- [Production Cloud Run workflow](../../.github/workflows/deploy-sdp-api-gcp-prod.yml)
- [Release Flow workflow](../../.github/workflows/release-please.yml)
- [Doppler Secrets Operations](./doppler-secrets.md)
