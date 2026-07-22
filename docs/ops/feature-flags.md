# Feature Flag Inventory

A single, current map of every feature flag in the SDP monorepo: what each one gates, how it defaults, its state per environment, who owns it, and (for temporary flags) when it should be retired.

Feature flags are the release surface. They are how we ship incomplete work safely, disable a live feature without a deploy, and roll back fast. This inventory exists so that no release goes out with an unaccounted-for flag, no rollout flag rots after its feature ships, and no flag silently drifts between environments.

**Source of truth:** `origin/main` as of 2026-07-22. A local checkout can lag `origin/main`; always read flags from `origin/main`, not a working tree. See [Maintenance](#maintenance) for how to regenerate.

**Access note:** the live per-environment values (dev / staging / prod) live in Doppler (backend) and Vercel (frontend). Until that access lands, the per-environment columns below read `TBD`. Everything else here is read directly from code and is authoritative.

## How flags work in SDP

- Flags are **environment variables**, not a flag service. There is no LaunchDarkly / Unleash / Split, and no database-backed flag table.
- **Backend** (`apps/sdp-api`): flags are optional string fields on the `Env` interface (`src/types/env.d.ts`), read through helpers in `src/lib/feature-flags.ts`. The helper `isTruthyFlag` treats `1`, `true`, `yes`, `on` (case-insensitive) as on; anything else or unset is off.
- **Frontend** (`apps/sdp-web`): flags are `NEXT_PUBLIC_*` variables read in `src/lib/*-feature.ts` helpers. In the managed deploy these are set as Vercel environment variables; in the Docker image they are baked as placeholders and swapped at container start by `apps/sdp-web/docker/inject-public-env.mjs` (the `__SDP_RT_<VAR>__` pattern), because `NEXT_PUBLIC_*` values are otherwise fixed at build time.
- **Watch for environment auto-enabling.** Some helpers turn a feature on automatically in non-production contexts regardless of the flag value. Where that happens it is called out explicitly below, because it is the most common source of "worked in dev/preview, missing in prod" surprises.
- **Planned migration:** these env-var flags are slated to move to native **Vercel Feature Flags** (a proper flags UI with per-environment targeting). When that lands, update this section and each flag's mechanism. This inventory is the migration checklist.

## Inventory

| Flag | Scope | Gates | Type | Default behavior | Owner |
|---|---|---|---|---|---|
| `ASSET_PROFILES_ENABLED` | backend | Asset Profiles issuance API + public token-metadata projection | Rollout | Auto-on in `development`; off elsewhere unless truthy | Arseniy (issuance) |
| `NEXT_PUBLIC_ASSET_PROFILES_ENABLED` | frontend | Issuance UI: create wizard + per-token asset-management workspace | Rollout | Auto-on in dev / test / all Vercel previews; prod requires `"true"` | Arseniy (issuance) |
| `PAYMENTS_RECURRING_COLLECTION_ENABLED` | backend | The recurring-payment collection cron job | Kill-switch | Off unless truthy | Zach (payments) |

### `ASSET_PROFILES_ENABLED` (backend)

- **Declared:** `apps/sdp-api/src/types/env.d.ts:188`
- **Helper:** `isAssetProfilesEnabled()` at `apps/sdp-api/src/lib/feature-flags.ts:14`. Returns true when `ENVIRONMENT === "development"` **or** the flag is truthy.
- **Gates:**
  - `apps/sdp-api/src/routes/asset-profiles/index.ts:22,28`: the `requireAssetProfilesFeature` middleware applied to the whole `/asset-profiles` route family; returns `FORBIDDEN` when off.
  - `apps/sdp-api/src/routes/issuance/handlers/metadata.ts:123`: when on, layers the Asset-Profile projection onto the public token-metadata response.
- **Default:** off in production and self-host (`infra/self-hosted/.env.example:47` → `ASSET_PROFILES_ENABLED=false`); **auto-on in the `development` environment** irrespective of the flag.
- **Live (Doppler, observed 2026-07-22):** `true` in both `dev` and `stg` (explicitly set, though the `development` environment auto-enables it regardless). Production config not accessible.
- **Retire when:** Asset Profiles is GA on the issuance backend and the guard is no longer wanted.

### `NEXT_PUBLIC_ASSET_PROFILES_ENABLED` (frontend)

- **Declared / read:** `apps/sdp-web/src/lib/asset-profiles-feature.ts:27` (helper `isAssetProfilesUiEnabled()`).
- **Gates the issuance UI:**
  - create wizard: `apps/sdp-web/src/app/dashboard/issuance/create/page.tsx:12`
  - per-token asset-management workspace: `apps/sdp-web/src/app/dashboard/issuance/[tokenId]/page.tsx:124`
  - issuance workspace surface: `apps/sdp-web/src/app/dashboard/issuance/issuance-workspace.tsx:141`
- **Default / auto-behavior (read this carefully):** the UI is auto-enabled when `NEXT_PUBLIC_SDP_ENVIRONMENT === "development"`, when `NEXT_PUBLIC_VERCEL_ENV` is `preview` or `development` (**so it is on in every Vercel preview deploy**), or under `NODE_ENV` development/test when no SDP/Vercel env is set. **Production requires the explicit `NEXT_PUBLIC_ASSET_PROFILES_ENABLED="true"`.** The local example ships it on (`apps/sdp-web/.env.local.example:28` → `=true`).
- **Consequence:** the issuance UI is visible across dev, test, and every preview URL, and hidden in production unless the flag is explicitly set. Verifying it on a preview or smoke deploy does **not** confirm its production state. It is independent of the backend flag; both must be on for the feature to work end to end.
- **Live (observed 2026-07-22):** `true` in Doppler configs `dev` and `stg`, and present in Vercel for Preview/dev/Development. **This flag is managed in Doppler** (not only Vercel) and surfaced to the frontend build, which is why the Vercel Production/Shared stores were empty. **No production config is accessible** from current Doppler access (`dev`, `dev_personal`, `dev_ci`, `stg`; no `prd`) or Vercel (empty Production/Shared), so prod state is unread. **Consolidated open question for Andrey (devops): where does production config live, and how is prod flag state read?**
- **Retire when:** Asset Profiles UI is GA and the production gate is no longer wanted (retire together with the backend flag).

### `PAYMENTS_RECURRING_COLLECTION_ENABLED` (backend)

- **Declared:** `apps/sdp-api/src/types/env.d.ts:183` (with non-flag tuning config alongside: `..._BATCH_SIZE:184`, `..._RETRY_AFTER_MINUTES:185`).
- **Helper:** `isRecurringPaymentCollectionEnabled()` at `apps/sdp-api/src/lib/feature-flags.ts:8`.
- **Gates:** whether the background recurring-payment collection job is scheduled (`apps/sdp-api/src/cron/runner.ts:81`).
- **Default:** off unless truthy (`infra/self-hosted/.env.example:82` → `PAYMENTS_RECURRING_COLLECTION_ENABLED=false`).
- **Type:** operational kill-switch for the collection cron. This is the only recurring-payments flag that survives; the recurring-payments *master* flag (`PAYMENTS_RECURRING_ENABLED`) and its frontend counterpart were removed in #766, so subscription and recurring endpoints are no longer feature-gated, only the collection cron is.
- **Live (Doppler, observed 2026-07-22):** unset in both `dev` and `stg`, so the collection cron is off in both. Production config not accessible.

### Operational and diagnostic toggles (not product flags)

These are env-controlled toggles surfaced by a full sweep. They are not product feature flags (they gate diagnostics and observability, not user-facing features), but they are listed so the inventory is exhaustive.

- **`NEXT_PUBLIC_ENABLE_NETWORK_DEBUG`** (frontend): turns on network debugging in the dashboard. Read at `apps/sdp-web/src/lib/network-debug.ts:32` (on when `="true"`). Developer diagnostic; off by default.
- **`NEXT_PUBLIC_DISABLE_SENTRY`** (frontend): disables Sentry error reporting on the frontend when `="1"`. Read in `apps/sdp-web/next.config.ts`, `sentry.*.config.ts`, and `instrumentation-client.ts`. The frontend counterpart of the backend Sentry gate; observability config, not a feature.

## Per-environment state

To be completed once Doppler (backend) and Vercel (frontend) access lands. The code-level default is filled from source; the hosted values are the actual Doppler/Vercel settings.

| Flag | Code default | dev | staging | prod |
|---|---|---|---|---|
| `ASSET_PROFILES_ENABLED` | auto-on in `development`, else off | `true` | `true` | not accessible (Andrey Q) |
| `NEXT_PUBLIC_ASSET_PROFILES_ENABLED` | auto-on in dev/test/preview, else off | `true` | `true` | not accessible (Andrey Q) |
| `PAYMENTS_RECURRING_COLLECTION_ENABLED` | off | unset → off | unset → off | not accessible (Andrey Q) |

Values read from Doppler configs `dev` and `stg` (2026-07-22). **Config source & access:** backend flags live in Doppler; the frontend `NEXT_PUBLIC_*` flags are **also managed in Doppler** (`NEXT_PUBLIC_ASSET_PROFILES_ENABLED=true` in both `dev` and `stg`) and surfaced to the frontend build, which is why Vercel's Production/Shared stores looked bare. Current access covers `dev`, `dev_personal`, `dev_ci`, and `stg` only; **no `prd`/production config is visible** in Doppler, and Vercel Production/Shared are empty for this account. Production flag state is therefore unread. `docs/ops/release-operations.md` indicates prod runtime config (env vars, Secret Manager references) lives on the Cloud Run service itself, set outside the image-deploy workflows, which is consistent with there being no `prd` Doppler config in view. Open question for Andrey (devops): is prod flag state a Secret Manager reference on the `sdp-prod-api-public` service, or a prod Doppler config that needs a separate access grant?

## Upcoming flags (announced, not yet in code)

- **BYOK (bring-your-own-keys).** Owner: Pavel. Per the BYOK epic (`HOO-763`), the feature will ship step by step behind a feature flag so it does not affect current behavior, preserves existing wallets, and can roll back fast. No `*BYOK*_ENABLED` flag exists on `origin/main` yet. Add its row here the moment the flag lands.
- **Earn: `NEXT_PUBLIC_EARN_ENABLED` (frontend).** Already configured in Vercel (`sdp-web`, Preview, branch `earn-initial`, added ~2026-07-21) but the consuming code lives on the `earn-initial` branch and is not merged to `origin/main` (confirmed: no `EARN` token anywhere in `origin/main`). An in-development "Earn" feature. Add code citations and owner when the branch merges. Surfaced from Vercel, not the code, a code sweep on `main` cannot see branch-only flags.

## Housekeeping

- **Orphan example var.** `NEXT_PUBLIC_PAYMENTS_RECURRING_COLLECTION_ENABLED` appears in `apps/sdp-web/.env.local.example:30` (empty) but is referenced nowhere in `apps/sdp-web/src`. It is a leftover from the recurring UI removed in #766. Candidate for deletion from the example file.
- **Retired in #766.** `PAYMENTS_RECURRING_ENABLED` (backend master), its helper `isRecurringPaymentsEnabled`, and the frontend `recurring-payments-feature.ts` helper were removed. They are gone from `origin/main`; a lagging local checkout may still show them.
- **Stale Vercel config.** `NEXT_PUBLIC_PAYMENTS_RECURRING_ENABLED` (frontend recurring master) is still configured in Vercel `sdp-web` (Development + dev, added 2026-07-17) even though #766 deleted the code that reads it. Nothing consumes it now. Remove from Vercel. (Observed 2026-07-22; confirm the exact variable name in the console.)

## Not feature flags (config gates, listed to avoid confusion)

These env vars switch behavior but are configuration, not feature flags, and are out of scope for this inventory: `SENTRY_DSN` (via `isSentryEnabled`), `DISABLE_CRON`, `SOLANA_MOCK`, `KORA_SURFPOOL_SHIM`, `SDP_DEPLOYMENT_MODE` (managed/self_hosted), `RUN_INTEGRATION_TESTS`. Provider entitlement (payment/screening providers) is driven by which provider credentials are set and per-organization overrides, not by `_ENABLED` flags.

## Maintenance

This inventory is only useful if it stays current. Refresh it whenever a release adds, removes, or changes a flag.

To regenerate the flag list from `origin/main`:

```sh
# EVERY toggle token across the repo, do NOT search only *_ENABLED, that misses
# ENABLE_/DISABLE_/_FLAG-style toggles (this is how NETWORK_DEBUG/DISABLE_SENTRY were first missed)
git grep -hoE "[A-Z][A-Z0-9_]*(_ENABLED|_FLAG)" origin/main -- apps packages infra | sort | uniq -c | sort -rn
git grep -hoE "NEXT_PUBLIC_[A-Z0-9_]+" origin/main -- apps/sdp-web | sort -u   # scan for ENABLE_/DISABLE_ toggles too

# backend helpers and env schema
git show origin/main:apps/sdp-api/src/lib/feature-flags.ts
git show origin/main:apps/sdp-api/src/types/env.d.ts | grep -nE "_ENABLED"

# flag files, flag-service SDKs (should be none), example-file defaults
git ls-tree -r --name-only origin/main | grep -iE "feature|flag" | grep -v node_modules
git grep -liE "launchdarkly|unleash|flagsmith|growthbook|@vercel/flags" origin/main -- apps packages
git grep -nE "_ENABLED" origin/main -- '*.env.example' '*.env.local.example'
```

Cross-check each flag's declaration against its consumers, and confirm any environment auto-enabling in the helper (the `ENVIRONMENT === "development"` style short-circuits). Automating this refresh is tracked separately.

## See also

- [`release-operations.md`](./release-operations.md): release, Cloud Run deploy, and rollback runbook (where prod runtime config lives, the release gate, and the production verification checklist).
- [`doppler-secrets.md`](./doppler-secrets.md): Doppler secrets operations (the backend config source these flags are read from).
