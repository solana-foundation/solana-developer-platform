# Release Operations

> **Maintainers only.** This guide covers releases, Cloud Run deployment, and rollback for the hosted SDP API.

## Deployment Model

| Event | Target | Result |
| --- | --- | --- |
| Pull request labelled `deploy-dev` | Dev | Builds the pull request, runs migrations, updates the dev service, cron job, and worker |
| Pull request labelled `ephemeral-api` | Dev (per-PR) | Stands up an isolated `sdp-dev-api-pr-<n>` service with its own database and Redis db; torn down when the PR closes or the label is removed |
| Relevant push to `main` | Stage | Builds a SHA-tagged image from source, runs migrations, updates the stage service, cron job, and worker, then runs the stage smoke |
| Every push to `main` | GHCR | Builds, scans, attests, and keyless-signs the `sdp-api` image tagged with the commit SHA |
| `chore(main): release X.Y.Z` commit on `main` | Release publication | Creates the `vX.Y.Z` tag and the GitHub release, then starts the production API deployment in the same workflow run |
| `vX.Y.Z` tag push | GHCR | Builds, scans, attests, and keyless-signs the `sdp-api`, `sdp-web`, and `sdp-docs` images tagged with the version; publishes signed self-hosted checksums to the release |
| Release publication job on `main` | Production API | Verifies the tag and SHA, gates on the stage smoke, verifies the signed release image at its origin, promotes that exact digest to Artifact Registry, runs migrations, deploys a no-traffic candidate, promotes it, and runs the production canary. Never rebuilds |
| `chore(main): release X.Y.Z` commit on `main` | Production web | Vercel's git integration builds `sdp-web` for production only when the `main` commit is authored by the release app; every other `main` push is skipped |
| Any push to `main` | Production docs | Vercel's git integration builds and deploys `sdp-docs` to production on every `main` commit, with no release gate |
| Manual dev workflow dispatch | Dev | Rebuilds and deploys the selected ref |
| Manual stage workflow dispatch | Stage | Rebuilds and deploys the selected ref, then runs the stage smoke |
| Manual production workflow dispatch from `main` | Production API | Resolves an existing 40-character Git SHA image in Artifact Registry, verifies its signature, and redeploys its immutable digest through the candidate, promote, and canary steps without running migrations |

Vercel builds previews for pull-request branches. `apps/sdp-web/vercel.json` carries an ignore step that lets a `main` build through only when the commit author is the release app, so `sdp-web` reaches production exclusively through a merged release pull request. `apps/sdp-docs` has no such gate. Hotfix redeploys of the web app use the Vercel dashboard's Redeploy action; there is no workflow for it.

The hosted API runs as a Node.js container on Cloud Run. Dev, stage, and production use separate GCP projects, Artifact Registry repositories, services, migration jobs, cron jobs, and worker services.

A continuous production deployment path exists in [`deploy.yml`](../../.github/workflows/deploy.yml) behind the `CONTINUOUS_PROD_DEPLOY` repository variable. When it is enabled, a merge to `main` that passes the stage smoke and carries no migrations since the last release tag would promote the signed merge image to production the same way a release does.

## GitHub and GCP Setup

### GitHub environments

The `production` environment is attached to the production deployment job. Configure required reviewers there only if production needs an approval in addition to the generated release pull request.

### GitHub variables

Configure these deployment values as repository variables:

- `DEPLOY_WIF_PROVIDER` and `DEPLOY_SA`: Google Workload Identity provider and service account used by the dev, ephemeral, and production deploy workflows. The production job runs in the `production` environment, which may override them
- `STAGE_DEPLOY_WIF_PROVIDER` and `STAGE_DEPLOY_SA`: the same pair for the stage project. The stage deployment job is skipped while either is empty
- `STAGE_SMOKE_READY`: when `true`, the stage smoke builds the dashboard against the stage API and runs the read-only Playwright suite; otherwise it only probes `/health/ready`
- `CONTINUOUS_PROD_DEPLOY`: when `true`, enables the continuous production path described above

The deploy identities need the least-privilege permissions required to push to the target Artifact Registry repository and update/execute the named Cloud Run services and jobs.

Release automation also reads these repository variables:

- `TRANSLATION_AGENT_URL`: required when a release has missing UI translations
- `TRANSLATION_AGENT_MODEL`: optional model name included in the release summary; the translation agent defaults to `deepseek/deepseek-v4-flash`
- `TRANSLATION_AGENT_BATCH_SIZE`: optional request batch size; defaults to `50`
- `TRANSLATION_AGENT_MAX_RETRIES`: optional retry count; defaults to `2`
- `TRANSLATION_AGENT_MAX_KEYS`: optional cap on keys processed per run

### Repository secrets

- `DOPPLER_CI_IDENTITY_ID` (repository variable): Doppler service-account identity for OIDC-based secret-aware CI. The Slack notifications, the stage smoke, and the ephemeral environments read their secrets through it
- `RELEASE_APP_ID`: GitHub App ID used by release automation
- `RELEASE_APP_PRIVATE_KEY`: corresponding GitHub App private key
- `TRANSLATION_AGENT_USERNAME` and `TRANSLATION_AGENT_PASSWORD`: HTTP Basic credentials required when a release has missing UI translations

The release GitHub App needs `contents: write` and `pull_requests: write`, and it must be allowed to maintain the generated release branch and enable auto-merge. The repository must allow auto-merge and squash merging; `release-flow.mjs prepare` fails with the missing setting named when either is off.

No workflow reads Vercel credentials any more. The web production deployment moved to Vercel's git integration, so `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` are unused if they still exist on the `production` environment.

### Cloud Run resources

| Environment | Project | Artifact repository | Service | Migration job | Cron job | Worker |
| --- | --- | --- | --- | --- | --- | --- |
| Dev | `solana-developer-platform-dev` | `sdp-dev` | `sdp-dev-api-public` | `sdp-dev-api-public-migrate` | `sdp-dev-api-public-cron` | `sdp-dev-worker` |
| Stage | `solana-developer-platform-stg` | `sdp-stage` | `sdp-stage-api-public` | `sdp-stage-api-public-migrate` | `sdp-stage-api-public-cron` | `sdp-stage-worker` |
| Production | `solana-developer-platform` | `sdp-prod` | `sdp-prod-api-public` | `sdp-prod-api-public-migrate` | `sdp-prod-api-public-cron` | `sdp-prod-worker` |

All resources currently use `us-central1`. Production also has the `sdp-prod-canary` job, executed after every promotion. Ephemeral per-PR environments live in the dev project as `sdp-dev-api-pr-<n>` and `sdp-dev-worker-pr-<n>`.

Hosted API hostnames:

| Environment | Hostname |
| --- | --- |
| Dev | `https://api-dev.solana.com` |
| Stage | `https://api-stage.solana.com` (also served as `https://api-preview.solana.com`) |
| Production | `https://api.solana.com` |

The workflows update images only. Runtime environment variables, Secret Manager references, service accounts, networking, scaling, and scheduler configuration must already exist on the Cloud Run resources. A release that removes or adds a runtime variable needs that change applied to the Cloud Run configuration separately; check the release pull request body for such notes before approving.

Configure `PUBLIC_API_ORIGIN` directly on each API service before deployment:

| Environment | Required value |
| --- | --- |
| Dev | `https://api-dev.solana.com` |
| Production | `https://api.solana.com` |

This value is mandatory for hosted services because token deployment embeds metadata URLs permanently on-chain. Do not rely solely on request-derived proxy headers for those URLs. The image-only workflows preserve this service configuration and do not create or update it.

## Normal Change Flow

### 1. Merge a feature pull request

Use a conventional pull request title such as `feat:`, `fix:`, `perf:`, `docs:`, or `refactor:`. Release automation uses the merged history to calculate the next version and changelog. Merging is a release decision: the commit joins the next release pull request the moment it lands on `main`.

When the pull request merges, three things run on the push:

1. [`deploy.yml`](../../.github/workflows/deploy.yml) deploys to **stage** if an API, package, workspace, lockfile, or deploy-workflow path changed. It builds the image from source through [`deploy-sdp-api-gcp-stage.yml`](../../.github/workflows/deploy-sdp-api-gcp-stage.yml): migrations, service, readiness, cron job, worker, then the stage smoke from [`sdp-stage-smoke.yml`](../../.github/workflows/sdp-stage-smoke.yml).
2. [`release-images.yml`](../../.github/workflows/release-images.yml) builds the `sdp-api` image, scans both platforms with Trivy (critical findings fail the build), pushes it to GHCR tagged with the commit SHA with SLSA provenance and an SBOM, and signs it with keyless cosign. This is the artifact a release later promotes; nothing is rebuilt at release time.
3. [`release-please.yml`](../../.github/workflows/release-please.yml) recomputes the release plan and rewrites the release pull request (see step 2).

Dev is no longer deployed on merge. To put a branch on dev before it merges, add the `deploy-dev` label to the pull request ([`deploy-dev-on-label.yml`](../../.github/workflows/deploy-dev-on-label.yml)); to get an isolated per-PR API with its own database, add `ephemeral-api` ([`sdp-api-ephemeral.yml`](../../.github/workflows/sdp-api-ephemeral.yml)), which comments the URL on the pull request.

Verify the stage deployment before approving a release:

```bash
curl --fail-with-body https://api-stage.solana.com/health/ready
```

The response carries the Cloud Run revision name; match it to the deploy run's summary. Also exercise the affected authenticated, webhook, or provider flow; readiness only proves that the process, Postgres, and Redis are reachable.

### 2. Review the generated release pull request

The Release Flow workflow maintains `sdp/release-main` and opens a pull request titled `chore(main): release X.Y.Z`. It updates:

- `package.json`
- `.github/.release-please-manifest.json`
- `CHANGELOG.md`
- missing UI translations, when applicable

The pull request is recreated on every push to `main`, so its contents, title, and version can change while it is open. Three consequences of the branch ruleset (see [branch-controls.md](./branch-controls.md)) follow from that:

- Every push to `main` dismisses the approvals on it. A release pull request approved during working hours can lose that approval to the next merge; approve when nothing else is about to land, or agree a short merge pause first.
- The ruleset requires an extra approval for unattributed changes, and the release commits are authored by the release app. Plan for two approving reviews, and the approver cannot be the last person who pushed to the branch.
- Auto-merge is armed by the release app and re-armed whenever the version in the headline drifts. Once the required approvals and checks are green the pull request merges on its own and the production deployment starts within a minute. Approval on the release pull request is the release decision; there is no later confirmation step.

Read the pull request body before approving. It lists every commit in the release, and authors record migration notes and runtime-configuration changes there.

#### Translation sync

`translate-release-strings` runs after the release pull request exists, as a separate `continue-on-error` job.

**This moves the catalog gate off `main`.** `validateCatalogs` has no caller outside this job, so a catalog defect used to fail Release Flow on the push to `main` and now cannot. The signal is the `Eve translation sync` comment on the release pull request, plus the job's own red status inside an otherwise green run. Read that comment before merging a release: the release pull request is the only place a translation problem can still stop anything.

The job queues a key when it is missing from a locale **or** when the value already committed is one the validator would reject: a placeholder set that no longer matches English, forbidden terminology, unparseable ICU. Both sides share one predicate, so the validator can never reject something the collector will not retranslate. That symmetry is the fix for the 2026-08 stall, where an English string gained a placeholder, the collector skipped the key because it was present, and the validator rejected it on every run for sixteen days.

Every run posts or updates one comment, so a missing comment means the job never ran, not that it passed.

| Status | Meaning |
| --- | --- |
| `no-op` | Nothing to translate; catalogs validated clean. |
| `generated` | Every batch succeeded and was committed to the release branch. |
| `partial` | Some batches failed and are deferred to the next run; the batches that succeeded are still committed. Only drift this run *introduced* blocks the commit. |
| `failed` | The run threw before it could finish, most often because a source key changed shape in a way `applyTranslations` cannot write. The comment carries the error and a link to the run. Nothing is lost; the next push to `main` retries. |

### 3. Deploy and publish production

Merging the release pull request creates a `chore(main): release X.Y.Z` commit on `main`. That push runs [`release-please.yml`](../../.github/workflows/release-please.yml) in publish mode. The whole production release is one workflow run, named `Release Flow`, with these jobs in order:

1. `publish-release` creates the `vX.Y.Z` tag and the GitHub release, then checks that the tag resolves to the exact `main` commit it is running on. A release commit whose subject names a different version than `package.json` is refused here, before anything deploys.
2. The tag push starts [`release-images.yml`](../../.github/workflows/release-images.yml) in parallel: it builds, scans, attests, and signs the `sdp-api`, `sdp-web`, and `sdp-docs` images with the version tag, and [`release-checksums.yml`](../../.github/workflows/release-checksums.yml) attaches signed self-hosted checksums to the release.
3. `deploy-api-production` calls [`deploy-sdp-api-gcp-prod.yml`](../../.github/workflows/deploy-sdp-api-gcp-prod.yml) with the release SHA and tag. It does not appear as a separate run in the Actions list; open the `Release Flow` run to watch it.

Web and docs deploy through Vercel's git integration on the same push: `sdp-web` because the release app authored the commit, `sdp-docs` as on every `main` push. Their results show as `Vercel – sdp-web` and `Vercel – sdp-docs` commit statuses on the release commit.

The production deploy job, in order:

1. **Gate on stage smoke.** Runs [`sdp-stage-smoke.yml`](../../.github/workflows/sdp-stage-smoke.yml) against the stage API. With `STAGE_SMOKE_READY` unset it is a readiness probe; with it set it builds the dashboard against stage and runs the read-only Playwright suite. A failure stops the release before production is touched.
2. **Verify release identity.** [`verify-release-identity.sh`](../../.github/scripts/verify-release-identity.sh) checks that the checked-out commit is the release SHA, that the tag resolves to it, that it is contained in `origin/main`, and that the tag version matches `package.json`.
3. **Verify and promote the release image.** Waits for `ghcr.io/solana-foundation/sdp/sdp-api:vX.Y.Z` to be published by the parallel image build (up to about 65 minutes), then runs `cosign verify` against it with the GitHub OIDC issuer, the certificate identity pinned to `release-images.yml` at `refs/tags/vX.Y.Z`, and the certificate's workflow SHA pinned to the release commit. On success it copies that digest into Artifact Registry as `sdp-api-public:<release-sha>` and tags it `X.Y.Z`. Verification failure fails the job.
4. **Resolve the immutable deploy image.** Reads the digest back from Artifact Registry and refuses to continue unless it equals the verified origin digest.
5. **Run database migrations.** Updates and executes `sdp-prod-api-public-migrate` with that digest.
6. **Capture rollback state.** Records the current traffic split, cron image, and worker image.
7. **Deploy the candidate without traffic.** Creates a new revision tagged `candidate-<sha12>` at 0% traffic and checks that the revision's image digest is the pinned digest or a platform manifest inside that signed index.
8. **Verify candidate readiness.** Polls the revision's Ready condition for up to two minutes.
9. **Promote.** Verifies the cron cadence, moves 100% of traffic to the candidate, polls `https://api.solana.com/health/ready` until it reports the candidate revision with Postgres and Redis ok, then updates the cron job and worker to the same digest.
10. **Run the production canary.** Executes the `sdp-prod-canary` job and waits for it.
11. **Roll back an incomplete rollout.** If the rollout started but did not complete, restores the previous traffic split, cron image, and worker image. An incomplete restore fails the job with `Automatic rollback was incomplete; escalate immediately.`
12. **Remove the candidate traffic tag.**

A failure before step 9 leaves production serving the previous revision. A failure during or after step 9 triggers step 11. Migrations (step 5) are not rolled back by the workflow.

Slack receives a start and a result message for every production deployment when the deploy webhook is configured.

Do not treat the GitHub release publication as proof that the Cloud Run rollout succeeded; the release exists from step 1 of the run, the deploy finishes at step 12.

### 4. Verify production

Check:

1. The `deploy-api-production / Deploy production image` job in the `Release Flow` run completed successfully, and its summary names the candidate revision and digest.
2. The migration job execution succeeded.
3. `https://api.solana.com/health/ready` reports `status: ready`, the promoted revision name, and `database` and `redis` ok.
4. The cron job and worker reference the same release image as the service.
5. The canary job execution succeeded.
6. Cloud Run error rate, latency, and logs remain healthy. The API no longer reports to Sentry; its 5xx-ratio and cron-staleness alerts come from Grafana on Loki. Sentry covers the web app only.
7. At least one representative authenticated API flow succeeds.
8. The `Vercel – sdp-web` and `Vercel – sdp-docs` statuses on the release commit are green.

`/health` does not identify the release. Use the revision name from `/health/ready` and the run summary, or a behaviour that the release introduced, to confirm what is running.

## Manual Deployment

Manual dispatch of the production workflow redeploys an image that already exists in Artifact Registry. Run [`deploy-sdp-api-gcp-prod.yml`](../../.github/workflows/deploy-sdp-api-gcp-prod.yml) from `main` and provide:

- `image_sha` — the lowercase 40-character Git SHA tag attached to the intended image

Before dispatch, confirm that the SHA came from a successful, trusted production release workflow and that the resolved digest matches the expected release or incident record. The presence of a tag in Artifact Registry is not sufficient provenance on its own.

The dispatch path skips the stage smoke and the origin promotion, resolves the tag to its immutable digest, and then verifies the image signature: first on the Artifact Registry copy, and if that carries no findable signature, at the signing origin in GHCR at the same digest, accepting either a release-tag or a `main` identity from `release-images.yml` for that exact commit. An image that predates signed promotion fails here by design. It then runs the same candidate, readiness, promote, canary, and rollback-guard steps as a release. It never updates or executes the migration job.

## Production Rollback

1. Identify the last healthy release's full Git SHA from a successful, trusted production release workflow. Confirm its recorded digest and `sdp-api-public:<sha>` image still match in the production Artifact Registry repository.
2. Check the migrations that landed between that SHA and the current release. If any of them dropped, renamed, or constrained data the older code writes, the older image cannot run against the current schema; stop and fix forward instead.
3. Open `Deploy sdp-api to Cloud Run (prod)` in GitHub Actions and choose **Run workflow** from `main`.
4. Enter the full SHA as `image_sha`.
5. Approve the `production` environment gate if configured.
6. Follow the run until the service, cron job, and worker reference the resolved digest and the canary passes.
7. Repeat the production verification checklist and record the SHA, digest, reason, and operator in the incident timeline.

Database schema rollback is not automated. If the selected image is incompatible with the current schema, stop and prepare a forward fix instead of improvising a destructive migration.

### Schema compatibility

Migrations must remain backward-compatible across the rollback window:

- Add columns or tables before code depends on them.
- Avoid deleting or renaming data that the previous release reads.
- Separate destructive cleanup into a later release after rollback support expires.
- Test the previous application image against the migrated schema when a change is high risk.
- When a release ships a migration that breaks this rule, say so in the release pull request body so the rollback note is written before it is needed.

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
7. Remove the retired `CLOUDFLARE_*` resource IDs and credentials from Doppler and GitHub. Revoke a token only if the inventory proves it was dedicated to the API Workers; otherwise remove its API Worker access or rotate it with the owners of its remaining consumers. If no external consumer remains, also remove the obsolete production `DOPPLER_TOKEN` secret, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, and `CLOUD_SQL_INSTANCE_CONNECTION_NAME` variables, and unused `dev` or `release-production` GitHub environments. Preserve the `production` environment, `DEPLOY_WIF_PROVIDER`, `DEPLOY_SA`, and `DOPPLER_CI_IDENTITY_ID`.
8. Re-run the GCP and application checks, confirm no retired Worker route or runtime remains and no traffic reaches it, and verify that the service and cron job still reference the intended production digest. Record every resource identifier, action, timestamp, operator, and verification artifact in the access-controlled change record.

Do not copy old resource IDs into this repository. Resolve deletion targets from the secret manager and provider dashboards immediately before each action, and store credentials and other sensitive evidence in the approved secret-bearing system.

## Troubleshooting

### GCP authentication fails

Verify `DEPLOY_WIF_PROVIDER` and `DEPLOY_SA` (or the `STAGE_` pair), the GitHub OIDC subject conditions, and the deploy service account's permissions in the target project.

### Image push fails

Verify the Artifact Registry repository exists in `us-central1`, Docker authentication completed, and the deploy identity can upload artifacts.

### Release image never appears in GHCR or fails cosign verification

The production job waits for the parallel `Release Images` run. Open that run first: a Trivy critical finding or a build failure there is the usual cause, and the production job cannot proceed without the signed image. A verification failure on an image that is present means the signing identity or commit does not match the release; do not bypass it.

### Release pull request approval keeps disappearing

Every push to `main` recreates the release pull request and dismisses its approvals. Approve when no other merge is imminent, or agree a short pause on merging to `main` and then approve.

### Release pull request will not merge with one approval

The ruleset requires an extra approval for unattributed changes, and the release commit is authored by the release app. A second approving review from someone other than the last pusher is needed.

### `publish-release` refuses the release commit

`Release commit version X does not match package.json Y` means the squash headline the pull request merged with named an older version than the pull request contained. The release app re-arms auto-merge when the headline drifts, so this should not recur; if it does, no tag was created and nothing deployed. Re-run the release flow by opening a pull request that lands a correctly titled `chore(main): release Y` commit.

### Migration job fails

Inspect the Cloud Run job execution and application logs. Do not deploy the service past a failed required migration. Fix forward when possible; do not improvise a schema rollback in the workflow.

### Candidate digest does not match the pinned digest

Cloud Run records the platform manifest's digest on the revision, and the pinned image may be an OCI index. The job accepts the index digest or any manifest listed inside that signed index. Anything else means Artifact Registry served a different image than the one verified; stop and inspect the registry.

### Service update fails after migrations

In production, a candidate that fails readiness receives no production traffic and leaves the cron and worker images unchanged. Inspect startup logs, required environment and secret references, Cloud SQL/Redis connectivity, and health checks. If promotion fails later, verify that the workflow restored the previous traffic split, cron image, and worker image; escalate immediately if any restore was incomplete. In dev and stage, inspect the Cloud Run rollout directly and restore the previous revision when the backward-compatible schema permits it.

### Cron job, worker, and service use different images

Resolve each resource's image reference, choose the intended release SHA/digest, and update the stale resource. Do not leave reconciliation running on code that is incompatible with the serving revision.

## References

- [Merge deploy orchestrator](../../.github/workflows/deploy.yml)
- [Dev Cloud Run workflow](../../.github/workflows/deploy-sdp-api-gcp.yml) and [label trigger](../../.github/workflows/deploy-dev-on-label.yml)
- [Ephemeral per-PR API environments](../../.github/workflows/sdp-api-ephemeral.yml)
- [Stage Cloud Run workflow](../../.github/workflows/deploy-sdp-api-gcp-stage.yml) and [stage smoke](../../.github/workflows/sdp-stage-smoke.yml)
- [Production Cloud Run workflow](../../.github/workflows/deploy-sdp-api-gcp-prod.yml)
- [Release Flow workflow](../../.github/workflows/release-please.yml) and [release-flow.mjs](../../.github/scripts/release-flow.mjs)
- [Release Images workflow](../../.github/workflows/release-images.yml)
- [Release Checksums workflow](../../.github/workflows/release-checksums.yml)
- [Branch controls](./branch-controls.md)
- [Doppler Secrets Operations](./doppler-secrets.md)
