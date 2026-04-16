# Release Operations

⚠️ **Maintainers Only** — This guide covers deployment procedures for maintaining the SDP API.

---

## Release Model

The SDP API uses a two-environment release model:

| Trigger | Target | Deployment |
|---|---|---|
| Push to `main` | Dev environment | Automatic |
| Create semver tag `vX.Y.Z` | Production | Automatic |
| Create legacy tag `solana-developer-platform-vX.Y.Z` | Production | Automatic (for rollback compatibility) |

### Versioning

- **Semantic versioning** — Follow [semver.org](https://semver.org/) (MAJOR.MINOR.PATCH)
- **Release tags** — Format: `v1.2.3` or `solana-developer-platform-v1.2.3`
- **Git tags** — Trigger CI/CD workflows automatically
- **Release artifacts** — Generated and managed by Release Please (GitHub Action)

---

## GitHub Setup

Before deploying, configure these GitHub settings:

### GitHub Environments

Create two environments in repository settings:

- **Environment**: `dev`
- **Environment**: `production`

### Environment Secrets

Add to each environment:

**For `dev` environment:**
- `DOPPLER_TOKEN` — Doppler API token with read access to `dev` config

**For `production` environment:**
- `DOPPLER_TOKEN` — Doppler API token with read access to `prd` config

### Repository Secrets

Add to repository (not environment-specific):

- `DOPPLER_TOKEN_CI` — Doppler API token for CI workflows with read access to `dev_ci` config
- `RELEASE_PLEASE_TOKEN` — GitHub PAT or App token with:
  - `contents: write` — Create release tags
  - `pull-requests: write` — Update release PRs
  
  ⚠️ **Important**: The default `GITHUB_TOKEN` is insufficient. Release Please's tag must trigger the production deploy workflow, which requires explicit permissions.

---

## Doppler Config Mapping

Secrets are managed centrally in Doppler. GitHub/Vercel environments map to Doppler configs:

| GitHub Environment | Doppler Config | Purpose |
|---|---|---|
| `dev` | `dev` | Development environment deployments |
| `production` | `prd` | Production environment deployments |
| CI workflows | `dev_ci` | Secret-aware CI jobs (migrations, tests) |
| Vercel Preview | `stg` | Preview/staging environment |

### Secret Coverage

See [`docs/ops/doppler-secrets.md`](doppler-secrets.md) for the complete list of secrets that must be present in each Doppler config (Cloudflare credentials, database URLs, API keys, etc.).

---

## Release Flow

### 1. Create a Pull Request

Open a PR against `main` with a semantic commit message:

```bash
git checkout -b feat/your-feature
git commit -m "feat: Add new API endpoint"
git push -u origin feat/your-feature
```

**Semantic prefixes** (recognized by Release Please):

- `feat:` — New feature (MINOR version bump)
- `fix:` — Bug fix (PATCH version bump)
- `perf:` — Performance improvement (PATCH version bump)
- `BREAKING CHANGE:` — Major version bump (MAJOR)

Example of a breaking change:

```
refactor: Remove deprecated /v1/old-endpoint

BREAKING CHANGE: The /v1/old-endpoint has been removed. Use /v1/new-endpoint instead.
```

### 2. Merge to Main

After review and approval, merge the PR to `main`:

```bash
# Via GitHub UI or:
git checkout main
git pull origin main
git merge feat/your-feature
git push origin main
```

The `main` branch automatically deploys to the **dev environment** via the [Deploy SDP API workflow](../../.github/workflows/deploy-sdp-api.yml).

### 3. Release Please Opens a Release PR

Release Please (GitHub Action) automatically:

1. Analyzes commits since the last release
2. Determines the next version (MAJOR/MINOR/PATCH)
3. Opens a release PR with:
   - Updated `package.json` and `package-lock.json` (if applicable)
   - Generated `CHANGELOG.md` entries
   - Proposed version tag

Example release PR title: `chore(release): v1.2.0`

**Action**: Review the release PR. If the version/changelog look correct, approve and merge.

### 4. Merge the Release PR

When you merge the release PR:

1. Release Please creates a Git tag (e.g., `v1.2.0`)
2. The tag push triggers the [Deploy SDP API workflow](../../.github/workflows/deploy-sdp-api.yml)
3. The workflow:
   - Runs migrations (if applicable)
   - Deploys to **production environment**
   - Syncs secrets to Cloudflare Workers

### 5. Monitor the Deployment

Check GitHub Actions to verify the deployment completed:

1. Go to **Actions** → **Deploy SDP API**
2. Look for the latest run triggered by your tag
3. Verify all steps completed (migrations, deploy, secret sync)
4. Check logs for errors

---

## Production Rollback

To roll back to a previous production release:

### Via GitHub Actions

1. Go to **Actions** → **Deploy SDP API**
2. Click **Run workflow** (top right)
3. Fill in parameters:
   - **Environment**: `production`
   - **Ref**: Previous tag (e.g., `v1.2.2` or `solana-developer-platform-v0.2.0`)
   - **Run migrations**: Leave unchecked (unless you're intentionally rolling back + running migrations)
4. Click **Run workflow**

The workflow will redeploy that specific tag to production.

### Important: Schema Rollback

⚠️ **Code rollback is supported. Schema rollback is NOT automated.**

If you roll back code but the database schema is newer, the application may fail. To avoid this:

- **Never delete or rename database columns** — Mark as unused instead
- **Always make migrations backward-compatible** — Newly deployed code should work with the old schema
- **Test rollback scenarios** — Before merging a migration, verify the old code still runs against the new schema

Example safe migration pattern:

```sql
-- Add new column (old code ignores it, new code uses it)
ALTER TABLE users ADD COLUMN new_field TEXT;

-- Old code: works fine (ignores new_field)
-- New code: can use new_field if present
-- Rollback: old code works, new_field just sits there
```

Example unsafe migration pattern:

```sql
-- Delete old column (old code will crash if it tries to read it)
ALTER TABLE users DROP COLUMN old_field;
-- ❌ DANGER: Rollback will break
```

---

## Deployment Workflow Details

The CI/CD pipeline automatically:

1. **Validates production tag format** (must match `vX.Y.Z` or `solana-developer-platform-vX.Y.Z`)
2. **Authenticates to Google Cloud** (via Workload Identity)
3. **Runs database migrations** (if applicable)
4. **Syncs secrets to Cloudflare** (via Doppler)
5. **Deploys to Cloudflare Workers** (via `wrangler deploy`)

See [`.github/workflows/deploy-sdp-api.yml`](../../.github/workflows/deploy-sdp-api.yml) for implementation details.

---

## Troubleshooting

### Release Please doesn't create a release PR

**Cause**: No semantic commits since last release.

**Solution**: Ensure PR titles follow the semantic format (`feat:`, `fix:`, `perf:`, etc.).

### Production deployment fails with "Doppler credentials missing"

**Cause**: `DOPPLER_TOKEN` secret not set in GitHub production environment.

**Solution**: 
1. Go to repository **Settings** → **Environments** → **production**
2. Add `DOPPLER_TOKEN` secret
3. Retry the deployment

### Rollback hangs or times out

**Cause**: Database migration is hanging.

**Solution**:
1. Manually cancel the workflow in GitHub Actions
2. Check the production database (Cloud SQL) for locks
3. Kill any hung queries
4. Retry the rollback with `run_migrations=false`

### Vercel Preview builds are not syncing secrets

**Cause**: Vercel is not pulling `stg` Doppler config.

**Solution**: Verify in Doppler that the `stg` config has all required environment variables. Restart the Vercel Preview deployment.

---

## Reference

- **Release Please docs**: https://github.com/googleapis/release-please
- **Doppler setup**: [`docs/ops/doppler-secrets.md`](doppler-secrets.md)
- **Cloudflare resource IDs**: [`docs/ops/cloudflare-resource-ids.md`](cloudflare-resource-ids.md)
- **Deploy workflow**: [`.github/workflows/deploy-sdp-api.yml`](../../.github/workflows/deploy-sdp-api.yml)
