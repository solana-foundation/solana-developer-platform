/**
 * Earn strategy-catalogue sync entrypoint.
 *
 * Two execution paths, both gated on the Earn feature flags by their callers:
 *
 * - **In-process cron** (`runEarnCatalogueSync`, self-hosted runtimes and
 *   explicitly opted-in services): mirrors `pending-transfers` — wraps the
 *   sync with a Sentry cron monitor when observability is supplied, and hands
 *   the resulting promise to the BackgroundRunner so it survives past the
 *   initiating tick and drains during graceful shutdown.
 * - **Managed Cloud Run Job** (`runEarnCatalogueSyncIfDue`, `src/job.ts`):
 *   the job is scheduled every five minutes, so each tick claims an hourly
 *   Redis slot first and skips quietly when the slot is held — the catalogue
 *   cadence stays `EARN_CATALOGUE_SYNC_CRON` no matter how often the job runs.
 *
 * The sync iterates every registered vault-infra provider per environment,
 * pulls the live strategy catalogue, and upserts it into `earn_strategies`
 * keyed on (provider, provider_reference, environment) — the only writer of
 * that table besides the dev seed. It degrades provider-by-provider: one
 * provider failing (or still being a NOT_IMPLEMENTED stub) must never sink
 * the others' pass. Adding a provider is a registry change only
 * (`EARN_PROVIDER_CLIENTS`) — neither execution path names providers.
 */

import { EARN_PROVIDER_CLIENTS, isStrategyWithinDeclaredSupport, SdpEarnError } from "@sdp/earn";
import type {
  EarnRuntimeContext,
  EarnVaultProvider,
  ProviderStrategySnapshot,
} from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import { createEarnRepository, type EarnRepository } from "@/db/repositories";
import type { BackgroundRunner } from "@/runtime/background";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";

export const EARN_CATALOGUE_SYNC_MONITOR = "sdp-api-sync-earn-catalogue";
// Catalogue drift is slow (a provider onboarding or delisting a vault), so
// hourly keeps rows fresh without hammering provider APIs.
export const EARN_CATALOGUE_SYNC_CRON = "0 * * * *";

// The managed Cloud Run Job ticks every five minutes (Cloud Scheduler in
// sdp-infra), far more often than the hourly cadence above. Each tick claims
// this Redis slot — an atomic INCR + TTL via admitSlidingWindow with
// maxRequests 1 — so exactly one tick per window syncs and overlapping
// executions lose cleanly. The TTL sits just under the hour so the next
// on-the-hour tick of the five-minute grid claims a fresh slot; a job that
// dies mid-sync self-heals when the slot expires (worst case: one skipped
// window).
export const EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS = 3540;
const EARN_CATALOGUE_SYNC_SLOT_KEY = "cron:earn-catalogue-sync:slot";
// admitSlidingWindow needs a previous-window key; nothing ever increments this
// one, which collapses the sliding window into a fixed once-per-TTL claim.
const EARN_CATALOGUE_SYNC_SLOT_PREVIOUS_KEY = "cron:earn-catalogue-sync:slot-previous";
// A failed sync releases its claim only while it provably still owns it: for
// the TTL minus this margin, the key cannot have expired, so a delete can only
// land on our own claim. Past that, a newer tick may have re-claimed the
// expired key and deleting would cancel *that* claim (see the release site).
const EARN_CATALOGUE_SYNC_SLOT_RELEASE_MARGIN_SECONDS = 60;

// The catalogue is platform-global but environment-scoped (sandbox rows carry
// devnet mints, production rows mainnet mints), so each provider syncs once
// per environment.
const SYNCED_ENVIRONMENTS: readonly SdpEnvironment[] = ["sandbox", "production"];

// Expected steady states, not incidents: stub integrations report
// NOT_IMPLEMENTED and environments without credentials report
// PROVIDER_NOT_CONFIGURED. Both skip quietly; anything else logs an error.
const SKIPPABLE_SYNC_ERROR_CODES: ReadonlySet<string> = new Set([
  "NOT_IMPLEMENTED",
  "PROVIDER_NOT_CONFIGURED",
]);

export async function syncEarnCatalogue(env: Env): Promise<void> {
  const repo = createEarnRepository(env);
  // Providers read their own credentials from the raw env keyed by
  // environment — same contract as the route-layer earnRuntime().
  const providerEnv = env as unknown as Record<string, string | undefined>;

  for (const environment of SYNCED_ENVIRONMENTS) {
    for (const client of Object.values(EARN_PROVIDER_CLIENTS)) {
      await syncProviderCatalogue(repo, client, { env: providerEnv, environment });
    }
  }
}

async function syncProviderCatalogue(
  repo: EarnRepository,
  client: EarnVaultProvider,
  ctx: EarnRuntimeContext
): Promise<void> {
  const logContext = { provider: client.provider, environment: ctx.environment };

  let snapshots: ProviderStrategySnapshot[];
  try {
    snapshots = await client.listStrategies(ctx);
  } catch (err) {
    if (err instanceof SdpEarnError && SKIPPABLE_SYNC_ERROR_CODES.has(err.code)) {
      getLogger().info(
        { ...logContext, code: err.code },
        "syncEarnCatalogue: provider catalogue skipped"
      );
      return;
    }
    getLogger().error(
      { ...logContext, error: err instanceof Error ? err.message : String(err) },
      "syncEarnCatalogue: failed to list provider strategies"
    );
    return;
  }

  for (const snapshot of snapshots) {
    // A snapshot outside the provider's declared support envelope is provider
    // drift (an unvetted deposit mint or an undeclared strategy shape) — flag
    // it and keep it out of the catalogue rather than persist it.
    if (!isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot)) {
      getLogger().warn(
        {
          ...logContext,
          provider_reference: snapshot.providerReference,
          source_kind: snapshot.sourceKind,
          deposit_mints: snapshot.depositMints,
        },
        "syncEarnCatalogue: strategy outside declared support"
      );
      continue;
    }

    try {
      await repo.upsertStrategy({
        provider: client.provider,
        providerReference: snapshot.providerReference,
        name: snapshot.name,
        sourceKind: snapshot.sourceKind,
        underlyingSource: snapshot.underlyingSource ?? null,
        depositMints: snapshot.depositMints,
        shareMint: snapshot.shareMint ?? null,
        apyType: snapshot.apyType,
        currentApy: snapshot.currentApy ?? null,
        liquidityTerm: snapshot.liquidityTerm,
        redemptionDelayDays: snapshot.redemptionDelayDays ?? null,
        riskMetadata: snapshot.riskMetadata ?? {},
        // Providers report no status; being listed is what makes a strategy
        // depositable, so the sync submits `active` for anything a provider
        // still lists. The repository upsert refuses to overwrite an operator
        // `paused`/`deprecated` status (earn.repository.postgres.ts) — an
        // operator stop outranks the sync; only an explicit status write
        // reopens the row.
        status: "active",
        environment: ctx.environment,
      });
    } catch (err) {
      getLogger().error(
        {
          ...logContext,
          provider_reference: snapshot.providerReference,
          error: err instanceof Error ? err.message : String(err),
        },
        "syncEarnCatalogue: failed to upsert strategy"
      );
    }
  }
}

export interface EarnCatalogueSyncDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runEarnCatalogueSync(deps: EarnCatalogueSyncDeps): void {
  const work = () => syncEarnCatalogue(deps.env);

  // Never invoke `work` eagerly — a sync throw before the first await must become
  // a rejected promise the BackgroundRunner can track, not propagate to the
  // runtime entrypoint.
  const promise = deps.observability
    ? deps.observability.withMonitor(EARN_CATALOGUE_SYNC_MONITOR, work, {
        schedule: { type: "crontab", value: EARN_CATALOGUE_SYNC_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}

export type EarnCatalogueSyncTickOutcome = "synced" | "skipped";

/**
 * One tick of the managed Cloud Run Job (`src/job.ts`): claim the hourly slot,
 * then sync under this task's own Sentry monitor. Ticks that lose the claim
 * skip without a monitor check-in, so Sentry sees check-ins matching
 * EARN_CATALOGUE_SYNC_CRON rather than the job's five-minute schedule.
 *
 * A failed sync releases the slot — the next five-minute tick retries instead
 * of waiting out the hour — and rethrows: syncEarnCatalogue already degrades
 * per provider and per row, so anything escaping it is infrastructure-level
 * and must fail the job loudly. The release is ownership-guarded: a sync that
 * outlived the slot TTL leaves the key alone, because a newer tick may have
 * re-claimed it and deleting would cancel that claim.
 *
 * Callers gate on isEarnEnabled first, mirroring the in-process registration
 * in cron/runner.ts.
 */
export async function runEarnCatalogueSyncIfDue(
  env: Env,
  observability?: Observability
): Promise<EarnCatalogueSyncTickOutcome> {
  const cache = createKVStoreSet(env).cache;
  const admission = await cache.admitSlidingWindow(
    EARN_CATALOGUE_SYNC_SLOT_KEY,
    EARN_CATALOGUE_SYNC_SLOT_PREVIOUS_KEY,
    {
      maxRequests: 1,
      previousWeight: 0,
      expirationTtl: EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS,
    }
  );
  if (!admission.admitted) {
    getLogger().info("syncEarnCatalogue: hourly slot already claimed, skipping this tick");
    return "skipped";
  }
  // Monotonic, so a wall-clock step (NTP) cannot fake an outlived claim.
  const claimedAtMs = performance.now();

  const work = () => syncEarnCatalogue(env);
  try {
    await (observability
      ? observability.withMonitor(EARN_CATALOGUE_SYNC_MONITOR, work, {
          schedule: { type: "crontab", value: EARN_CATALOGUE_SYNC_CRON },
        })
      : work());
  } catch (err) {
    // Release only while the claim is provably still ours. Inside
    // TTL - margin the key cannot have expired, and nothing else deletes it,
    // so the delete lands on our own claim. A sync that outlived that window
    // may be racing a newer tick that re-claimed the expired key —
    // unconditionally deleting would cancel that claim and invite overlapping
    // syncs — so the outlived claim is left to its current owner instead
    // (worst case: the failure waits out the hourly window to retry).
    const heldSeconds = (performance.now() - claimedAtMs) / 1000;
    if (
      heldSeconds <
      EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS - EARN_CATALOGUE_SYNC_SLOT_RELEASE_MARGIN_SECONDS
    ) {
      try {
        await cache.delete(EARN_CATALOGUE_SYNC_SLOT_KEY);
      } catch (releaseErr) {
        // Log-and-continue: a release failure must never mask the sync error,
        // and the slot's TTL bounds the damage to one skipped window.
        getLogger().error(
          { error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr) },
          "syncEarnCatalogue: failed to release hourly slot after sync failure"
        );
      }
    } else {
      getLogger().warn(
        { held_seconds: Math.round(heldSeconds) },
        "syncEarnCatalogue: failed sync outlived its slot TTL, leaving the slot to its current owner"
      );
    }
    throw err;
  }
  return "synced";
}
