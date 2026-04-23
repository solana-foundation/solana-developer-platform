# Maintainer Documentation Index

⚠️ **This directory is for maintainers only.** External contributors should see the main [`README.md`](../../README.md) and [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for public documentation.

---

## Overview

This directory contains operational and deployment documentation for SDP maintainers, including:

- Secret and credential management
- Release and deployment procedures
- Infrastructure configuration
- CI/CD pipeline details

---

## Documentation Files

### [Release Operations](./release-operations.md)

How to release, deploy, and roll back the SDP API.

**Covers:**
- Two-environment release model (dev/production)
- GitHub setup (environments, secrets)
- Release Please workflow
- Production rollback procedure
- Migration safety notes

**Read this when:** Preparing a release, deploying to production, or rolling back a deployment.

---

### [Doppler Secrets Operations](./doppler-secrets.md)

How secrets are managed via Doppler, and the CI/CD integration.

**Covers:**
- Doppler as single source of truth
- Config structure (dev, dev_ci, stg, prd)
- Required secrets per environment
- Local development with Doppler
- CI/CD secret injection
- One-time Doppler cutover procedure (completed)

**Read this when:** Setting up local development with Doppler, configuring CI/CD, or troubleshooting secret-related issues.

---

### [Cloudflare Resource IDs](./cloudflare-resource-ids.md)

How Cloudflare resource IDs (Hyperdrive, KV namespaces) are managed.

**Covers:**
- Why resource IDs are placeholders in git
- Resource ID mapping (dev/production)
- Required Doppler variables (WRANGLER_*)
- Injection mechanism
- Local development workarounds
- Troubleshooting

**Read this when:** Deploying the API, setting up local development, or configuring Cloudflare resources.

---

## Common Tasks

### I need to deploy a new release

1. Read [Release Operations](./release-operations.md)
2. Follow the release flow (PR → main → Release Please → tag → deploy)
3. Monitor the GitHub Actions workflow

### I need to access secrets locally

1. Read [Doppler Secrets Operations](./doppler-secrets.md)
2. Run `doppler login` and `pnpm dev`

### I need to configure a new environment (dev/staging/production)

1. Read [Doppler Secrets Operations](./doppler-secrets.md) — Set up Doppler config
2. Read [Cloudflare Resource IDs](./cloudflare-resource-ids.md) — Configure Cloudflare resources
3. Update GitHub environments and secrets (see Release Operations)

### I need to troubleshoot a failed deployment

1. Check GitHub Actions logs
2. Read the relevant doc:
   - Release/deploy issue → [Release Operations](./release-operations.md)
   - Secrets missing → [Doppler Secrets Operations](./doppler-secrets.md)
   - Cloudflare resource issue → [Cloudflare Resource IDs](./cloudflare-resource-ids.md)

---

## Quick Reference

### Doppler Configs

| Config | Purpose | Access |
|---|---|---|
| `dev` | Development environment | Team members with `dev` access |
| `dev_ci` | CI/CD secret injection | GitHub Actions via `DOPPLER_TOKEN_CI` |
| `stg` | Vercel Preview builds | Vercel via Doppler integration |
| `prd` | Production environment | Team members with `prd` access |

### GitHub Environments

| Environment | Target Doppler | Deploy Trigger |
|---|---|---|
| `dev` | `dev` | Push to `main` |
| `production` | `prd` | Create semver tag (`vX.Y.Z`) |

### Required Secrets (GitHub)

| Secret | Scope | Purpose |
|---|---|---|
| `DOPPLER_TOKEN` | `dev`, `production` envs | Access Doppler during CI/CD |
| `DOPPLER_TOKEN_CI` | Repo-wide | CI/CD secret injection |
| `RELEASE_PLEASE_TOKEN` | Repo-wide | GitHub release tag creation |

---

## Contact & Support

- **Questions about deployment?** — Check [Release Operations](./release-operations.md)
- **Questions about secrets?** — Check [Doppler Secrets Operations](./doppler-secrets.md)
- **Questions about Cloudflare?** — Check [Cloudflare Resource IDs](./cloudflare-resource-ids.md)
- **Still stuck?** — Open a GitHub issue or reach out to the maintainers listed above

---

**Last Updated**: April 2026
