# Doppler Secrets Operations

⚠️ **Maintainers Only** — This guide covers secret management and CI/CD configuration.

---

SDP now treats Doppler as the single source of truth for secret and environment-owned string configuration.

The runtime model does not change:

- `wrangler.toml` remains the source of truth for Worker binding names and committed local defaults
- environment-specific Cloudflare binding IDs live in Doppler and are rendered into a temporary Wrangler config during deploy
- Cloudflare remains the deployed runtime store for Worker secrets
- Vercel remains the deployed runtime store for `sdp-web` and `sdp-docs`
- GitHub Actions keeps only Doppler bootstrap tokens plus non-secret deploy metadata

## Doppler Shape

Create one Doppler project for the monorepo with these configs:

- `dev`
- `dev_ci`
- `stg`
- `prd`

For local development, create personal configs cloned from `dev` and set `DOPPLER_CONFIG` before running the root repo commands.

## Repo Commands

- `pnpm dev`
- `pnpm dev:api:local`
- `pnpm dev:web`
- `pnpm dev:docs`
- `pnpm test`
- `pnpm test:integration`
  These root-level commands run under `doppler run` automatically and use the active `DOPPLER_CONFIG`.
- `pnpm secrets:print:cloudflare`
  Prints the allowlisted Worker secret payload used by deploy automation and `wrangler secret bulk`.

## Same-Day Cutover Checklist

Before merging the PR:

1. Import current GitHub, Cloudflare, and Vercel values into the Doppler project.
2. Create service tokens for:
   - `dev_ci`
   - `dev`
   - `prd`
3. Set GitHub secrets:
   - repository secret `DOPPLER_TOKEN_CI`
   - `dev` environment secret `DOPPLER_TOKEN`
   - `production` environment secret `DOPPLER_TOKEN`
4. Set GitHub environment variables for API deploy migrations:
   - `GCP_WORKLOAD_IDENTITY_PROVIDER`
   - `GCP_SERVICE_ACCOUNT`
   - `CLOUD_SQL_INSTANCE_CONNECTION_NAME`
5. Leave `RELEASE_PLEASE_TOKEN` unchanged in GitHub.
6. Configure Doppler sync to Vercel for both apps:
   - `apps/sdp-web`
   - `apps/sdp-docs`
7. Map Doppler configs to Vercel environments:
   - `dev` -> Development
   - `stg` -> Preview
   - `prd` -> Production
8. Keep old GitHub, Cloudflare, and Vercel secrets in place for one successful deploy cycle as rollback insurance, but do not let repo workflows read them anymore.

## Required Doppler Coverage

At minimum, the Doppler configs used by automation must include:

- Cloudflare deploy credentials:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
- Cloudflare deploy binding IDs:
  - `CLOUDFLARE_HYPERDRIVE_ID`
  - `CLOUDFLARE_KV_SDP_API_KEYS_ID`
  - `CLOUDFLARE_KV_SDP_RATE_LIMITS_ID`
  - `CLOUDFLARE_KV_SDP_CACHE_ID`
  - `CLOUDFLARE_KV_SDP_SESSIONS_ID`
- API deploy and migration values:
  - `DATABASE_URL`
  - `API_KEY_PEPPER`
  - `CUSTODY_ENCRYPTION_KEY`
- API integration/provider values used in CI and runtime:
  - Solana RPC provider URLs and keys
  - `KORA_*`
  - `PRIVY_*`
  - `CLERK_*`
- Web and docs values synced to Vercel:
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

`SDP_DOCS_PROXY_ORIGIN` is the internal rewrite target for `sdp-web` `/docs` traffic. In production it must point at the docs project origin, `https://docs.platform.solana.com`, not the public canonical docs URL `https://platform.solana.com/docs`, otherwise the web app rewrites `/docs` back to itself.

## Local Development

1. Install the Doppler CLI and authenticate.
2. Set your local config, for example `export DOPPLER_CONFIG=gui-dev`.
3. Start the apps or tests from the repo root:

```bash
pnpm dev:api:local
pnpm dev:web
pnpm dev:docs
pnpm test
pnpm test:integration
```

If you run package-local commands directly instead of the root scripts, wrap them explicitly with `doppler run --config "${DOPPLER_CONFIG}" -- ...`.

Do not keep `apps/sdp-api/.dev.vars` in place while using `doppler run`. The local Worker script now fails fast if that legacy file is present, because Wrangler will otherwise prefer the file over injected process env.

## CI and Deploy Behavior

- Secret-aware CI jobs fetch runtime env directly from Doppler with `DOPPLER_TOKEN_CI`.
- The API deploy workflow fetches deploy-time env from the target Doppler config using the GitHub environment secret `DOPPLER_TOKEN` and the Doppler Secrets Fetch action.
- The API deploy workflow reads non-secret Cloud SQL identity metadata from GitHub environment variables.
- Postgres migrations connect through Google Workload Identity and Cloud SQL Auth Proxy; the Doppler `DATABASE_URL` host is rewritten to the local proxy only for the migration process.
- The deploy workflow renders a temporary Wrangler config with Doppler-backed Cloudflare binding IDs, then syncs the allowlisted Worker secret set via `wrangler secret bulk` before `wrangler deploy`.

Keep these deploy identity values in GitHub environment variables rather than Doppler:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`
- `CLOUD_SQL_INSTANCE_CONNECTION_NAME`

They are not application secrets, and the GitHub workflow needs them before it can authenticate to Google Cloud and fetch Doppler-backed runtime configuration.

## Rollback

If the Doppler cutover causes issues:

1. Revert the PR.
2. Restore the previous workflow inputs in GitHub Actions.
3. Keep the old runtime secrets in Cloudflare and Vercel until the rollback is complete.
