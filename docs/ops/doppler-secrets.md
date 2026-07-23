# Doppler Secrets Operations

> **Maintainers only.** This guide covers secret management and CI/CD configuration.

SDP uses Doppler for team development, secret-aware CI, and configuration synced to the hosted web and docs applications. The API's Cloud Run services and jobs are a separate deployment boundary: their runtime environment and secret references are configured in GCP and are preserved when GitHub Actions updates an image.

## Doppler Configs

The monorepo uses these shared configs:

| Config | Purpose |
| --- | --- |
| `dev` | Team development and the source for personal developer configs |
| `dev_ci` | Secret-aware CI and integration tests |
| `stg` | Preview/staging web and docs configuration |
| `prd` | Production web/docs configuration and operator access |

For local development, create a personal config cloned from `dev` and set `DOPPLER_CONFIG` before running root commands.

## Repo Commands

These root commands automatically run through the Doppler wrapper and use the active `DOPPLER_CONFIG`:

```bash
pnpm dev
pnpm dev:api:local
pnpm dev:web
pnpm dev:docs
pnpm test
pnpm test:integration
```

`pnpm secrets:print:docker` projects the allowlisted API environment into the format used by self-hosted Docker tooling. It does not update a hosted environment.

## Required Coverage

At minimum, the configs used by local development and CI should contain the values needed by the exercised features:

- API database and cache values such as `DATABASE_URL` and `REDIS_URL`
- application secrets such as `API_KEY_PEPPER`, `CUSTODY_ENCRYPTION_KEY`, and
  `CREDENTIAL_FINGERPRINT_PEPPER` when stored-credential provisioning is enabled
- authentication values under `CLERK_*`
- Solana RPC URLs and API keys
- Kora and custody-provider values used by integration tests
- compliance and ramp-provider credentials used by live discovery or integration coverage
- API observability values such as `SENTRY_DSN` and `SENTRY_TRACES_SAMPLE_RATE` when telemetry is enabled

The web and docs configs additionally provide their public URLs and browser-safe configuration, including:

- `SDP_API_BASE_URL`
- `NEXT_PUBLIC_SDP_API_BASE_URL`
- `NEXT_PUBLIC_SDP_API_URL`
- `NEXT_PUBLIC_SDP_DOCS_URL`
- `NEXT_PUBLIC_SDP_WEB_URL`
- `SDP_DOCS_PROXY_ORIGIN`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_JWT_TEMPLATE`
- `NEXT_PUBLIC_SENTRY_DSN`

`SDP_DOCS_PROXY_ORIGIN` is the internal rewrite target for `sdp-web` `/docs` traffic. In production it must point to the docs project origin, `https://docs.platform.solana.com`, rather than the public canonical URL `https://platform.solana.com/docs`; otherwise the web app rewrites `/docs` back to itself.

Only expose `NEXT_PUBLIC_*` values that are safe to include in browser bundles.

## Local Development

1. Install and authenticate the Doppler CLI.
2. Select a personal config, for example `export DOPPLER_CONFIG=gui-dev`.
3. Start the required apps or tests from the repository root.

If you run a package-local command directly, wrap it explicitly:

```bash
doppler run --config "${DOPPLER_CONFIG}" -- <command>
```

`apps/sdp-api/.env.local` remains available for local overrides and external contributors. The repository wrapper loads environment files as inert `KEY=VALUE` data; it does not source them as shell code. Do not commit local environment files.

## CI Behavior

- Secret-aware CI jobs use the repository secret `DOPPLER_TOKEN_CI` to read `dev_ci`.
- Fork pull requests cannot access that secret and use the workflow's documented fork-safe paths or skip live provider coverage.
- Vercel receives web/docs configuration through the configured Doppler integration.
- Release automation does not need a Doppler token.

Keep `DOPPLER_TOKEN_CI` narrowly scoped, rotate it through Doppler and GitHub together, and verify a secret-aware CI run after rotation.

## Cloud Run Boundary

The Cloud Run deploy workflows authenticate to Google Cloud using `DEPLOY_WIF_PROVIDER` and `DEPLOY_SA`. Push-triggered deployments build an image, push it to Artifact Registry, execute the migration job, update the API service, and update the cron job image. A manual production deployment instead resolves an existing SHA-tagged image to its immutable digest and never runs migrations.

They do **not** fetch Doppler or write runtime secrets. Before deploying a feature that adds an environment variable:

1. Add the variable to the application's environment contract and examples.
2. Configure the value or Secret Manager reference on both the API service and the relevant jobs in dev.
3. Deploy and verify dev.
4. Configure the production service and jobs through the normal GCP change process.
5. Confirm the value is present without printing it in GitHub Actions or Cloud Run logs.

An image update preserves the service/job configuration already stored in GCP. A missing value therefore requires a configuration change, not a rebuild.

## Rotation and Removal

When rotating a runtime secret:

1. Update its source of truth.
2. Update every consumer boundary that uses it: local/CI Doppler configs, Vercel sync, and/or GCP Secret Manager references.
3. Exercise the affected API or provider in dev.
4. Roll the production service and jobs if the platform does not pick up the new secret version automatically.
5. Revoke the old value only after all consumers are healthy.

When removing a secret, first remove all code and deployment references, then remove it from Doppler, GitHub, Vercel, and GCP as applicable.

## Rollback

Rolling back a Cloud Run image does not roll back runtime configuration or database schema. Keep configuration backward-compatible across the rollback window and follow [Release Operations](./release-operations.md) for the service and cron rollback procedure.
