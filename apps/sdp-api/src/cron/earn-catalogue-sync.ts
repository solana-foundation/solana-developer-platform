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
 * that table besides the dev seed. Each provider pass then DELISTS: rows the
 * provider no longer lists are deleted (`deleteUnlistedFromCatalogue`), so the
 * table converges on the live catalogue instead of only ever growing — that is
 * what makes a tightened catalogue gate reach rows already stored.
 * It degrades provider-by-provider: one
 * provider failing (or still being a NOT_IMPLEMENTED stub) must never sink
 * the others' pass. Adding a provider is a registry change only
 * (`EARN_PROVIDER_CLIENTS`) — neither execution path names providers.
 */

import { randomUUID } from "node:crypto";
import { EARN_PROVIDER_CLIENTS, isStrategyWithinDeclaredSupport, SdpEarnError } from "@sdp/earn";
import type {
  EarnRuntimeContext,
  EarnVaultProvider,
  ProviderStrategySnapshot,
} from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import { createEarnRepository, type EarnRepository } from "@/db/repositories";
import type { BackgroundRunner } from "@/runtime/background";
import type { KVStore } from "@/runtime/kv";
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
// this Redis slot first, so exactly one tick per window syncs and overlapping
// executions lose cleanly.
//
// The slot value is a unique claim token that embeds its own expiry
// (`<expiresAtEpochMs>:<uuid>`), and every transition is atomic on the exact
// prior value: an empty slot is claimed with compareAndSet(null → token), an
// expired one is taken over with compareAndSet(staleValue → token), and a
// failed sync releases with compareAndDelete(token) — which is a server-side
// no-op unless the claim still belongs to this execution, so a sync that
// outlives its slot can never delete a newer tick's claim. The expiry sits
// just under the hour so the next on-the-hour tick of the five-minute grid
// claims a fresh slot; a job that dies mid-sync self-heals once the token
// expires (worst case: one skipped window).
export const EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS = 3540;
const EARN_CATALOGUE_SYNC_SLOT_KEY = "cron:earn-catalogue-sync:slot";

// Lease validity: a claim only guarantees mutual exclusion while the holder's
// work is bounded well below the claim's expiry, so the sync itself carries a
// deadline. A pass is a handful of catalogue GETs (seconds today), so ten
// minutes is generous headroom while staying far under the slot TTL — an
// execution can therefore never still be syncing when its token expires and a
// newer tick takes over. On the deadline the tick fails loudly and releases
// its (provably still owned) claim; the job process exits, reaping any hung
// I/O. Managed Cloud Run additionally caps the whole execution at the job
// timeout (120s in sdp-infra), far under this — the deadline exists so the
// invariant holds on every runtime, not just managed.
export const EARN_CATALOGUE_SYNC_DEADLINE_SECONDS = 600;

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

  // The keep set for the delist pass below: references this sync accepts as
  // currently-listed. Built from the declared-support filter, not from upsert
  // results, so a transient write failure never reads as a delisting — but any
  // upsert failure still skips the pass entirely (`upsertFailed`), because a
  // half-applied catalogue cannot say what the provider no longer lists.
  const listedProviderReferences: string[] = [];
  let upsertFailed = false;

  for (const snapshot of snapshots) {
    // MAINNET INSTRUMENTS NEVER ENTER A NON-PRODUCTION CATALOGUE.
    //
    // Provider-neutral and deliberately enforced HERE, at the one writer of
    // `earn_strategies`, rather than trusted to each client: a sandbox row
    // naming a mainnet vault is an instrument no devnet wallet can reach, and
    // the whole point of a sandbox catalogue is that an integrator can act on
    // it. Kamino used to be catalogued this way on purpose (we believed it had
    // no devnet deployment; it does — see providers/kamino/devnet.ts), and the
    // rows were permanently `fundable: false`.
    //
    // This is a persistence gate, not a presentation one. `fundable` still
    // describes a row a caller CAN see; this stops the row existing at all.
    if (snapshot.hostCluster === "mainnet-beta" && ctx.environment !== "production") {
      getLogger().error(
        {
          ...logContext,
          provider_reference: snapshot.providerReference,
          host_cluster: snapshot.hostCluster,
        },
        "syncEarnCatalogue: refused a mainnet instrument in a non-production environment"
      );
      continue;
    }

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

    listedProviderReferences.push(snapshot.providerReference);

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
        // Taken from the PROVIDER, never derived from `ctx.environment` —
        // assuming the environment's cluster here is the silent lie this column
        // exists to prevent (migration 0057). Still true even though the guard
        // above now refuses mainnet instruments outside production: that guard
        // REJECTS a mismatch, which is only possible because the provider
        // stated the cluster in the first place.
        hostCluster: snapshot.hostCluster,
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
      upsertFailed = true;
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

  await deleteUnlistedFromCatalogue(repo, client, ctx, {
    listedProviderReferences,
    upsertFailed,
    logContext,
  });
}

/**
 * Delete catalogue rows the provider no longer lists — the other half of
 * keeping `earn_strategies` truthful. Upserting alone only ever adds: a vault
 * the provider delists, or one a tightened gate now refuses, would otherwise
 * keep its `active` row and stay depositable forever.
 *
 * Deliberately conservative — it skips rather than deletes whenever this
 * pass cannot prove what the provider currently lists:
 *
 * - `upsertFailed`: a partial write pass cannot distinguish "not listed" from
 *   "listed but not persisted".
 * - empty keep set: never tear down a whole shelf off one empty response (the
 *   repository refuses this too; the log here is what makes it visible).
 *
 * A skip costs one hour of staleness. Deleting wrongly costs a customer a
 * vault they were mid-deposit into, so the asymmetry decides the default.
 */
async function deleteUnlistedFromCatalogue(
  repo: EarnRepository,
  client: EarnVaultProvider,
  ctx: EarnRuntimeContext,
  args: {
    listedProviderReferences: readonly string[];
    upsertFailed: boolean;
    logContext: Record<string, unknown>;
  }
): Promise<void> {
  const { listedProviderReferences, upsertFailed, logContext } = args;

  if (upsertFailed || listedProviderReferences.length === 0) {
    getLogger().warn(
      {
        ...logContext,
        listed_count: listedProviderReferences.length,
        upsert_failed: upsertFailed,
      },
      "syncEarnCatalogue: skipped delist pass on an unreliable catalogue pass"
    );
    return;
  }

  try {
    const deleted = await repo.deleteUnlistedStrategies({
      provider: client.provider,
      environment: ctx.environment,
      listedProviderReferences,
    });
    if (deleted.length > 0) {
      getLogger().info(
        { ...logContext, deleted_references: deleted },
        "syncEarnCatalogue: deleted strategies the provider no longer lists"
      );
    }
  } catch (err) {
    getLogger().error(
      { ...logContext, error: err instanceof Error ? err.message : String(err) },
      "syncEarnCatalogue: failed to delete unlisted strategies"
    );
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
 * A failed or deadline-exceeded sync releases the slot — the next five-minute
 * tick retries instead of waiting out the hour — and rethrows:
 * syncEarnCatalogue already degrades per provider and per row, so anything
 * escaping it is infrastructure-level and must fail the job loudly. The
 * release is compareAndDelete on this execution's claim token, so it
 * atomically no-ops if a newer tick has taken the slot over in the meantime;
 * the sync deadline (far under the claim expiry) guarantees that never
 * happens while a sync is still running.
 *
 * Callers gate on isEarnEnabled first, mirroring the in-process registration
 * in cron/runner.ts.
 */
export async function runEarnCatalogueSyncIfDue(
  env: Env,
  observability?: Observability
): Promise<EarnCatalogueSyncTickOutcome> {
  const cache = createKVStoreSet(env).cache;
  const claimToken = await claimEarnCatalogueSyncSlot(cache);
  if (claimToken === null) {
    getLogger().info("syncEarnCatalogue: hourly slot already claimed, skipping this tick");
    return "skipped";
  }

  // The deadline sits inside the monitor wrapper so Sentry records an
  // exceeded run as a failed check-in rather than a forever-pending one.
  const work = () => withSyncDeadline(syncEarnCatalogue(env));
  try {
    await (observability
      ? observability.withMonitor(EARN_CATALOGUE_SYNC_MONITOR, work, {
          schedule: { type: "crontab", value: EARN_CATALOGUE_SYNC_CRON },
        })
      : work());
  } catch (err) {
    try {
      // Atomic owner check and delete in one step: no-ops unless the slot
      // still holds this execution's token, so a newer tick's takeover can
      // never be cancelled from here.
      await cache.compareAndDelete(EARN_CATALOGUE_SYNC_SLOT_KEY, claimToken);
    } catch (releaseErr) {
      // Log-and-continue: a release failure must never mask the sync error,
      // and the token's embedded expiry bounds the damage to one skipped
      // window.
      getLogger().error(
        { error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr) },
        "syncEarnCatalogue: failed to release hourly slot after sync failure"
      );
    }
    throw err;
  }
  return "synced";
}

// Rejects when the sync outlives its deadline, enforcing the lease-validity
// invariant above. The losing promise is not cancelled — the tick's failure
// exits the one-shot job process, which reaps any hung I/O — and the timer is
// unref'd/cleared so a fast pass neither leaks it nor holds the process open.
async function withSyncDeadline<T>(sync: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `earn catalogue sync exceeded its ${EARN_CATALOGUE_SYNC_DEADLINE_SECONDS}s deadline`
        )
      );
    }, EARN_CATALOGUE_SYNC_DEADLINE_SECONDS * 1000);
    timer.unref();
  });
  try {
    return await Promise.race([sync, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Claim token wire format: `<expiresAtEpochMs>:<uuid>`. Wall-clock epoch is
// deliberate — expiry must be comparable across job executions (a monotonic
// reading is process-local); NTP keeps cross-instance skew far below the
// minute granularity that matters here.
function makeSlotToken(): string {
  return `${Date.now() + EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS * 1000}:${randomUUID()}`;
}

// A value that doesn't parse (including the pre-token "1" a older build's
// INCR-based claim may have left behind) reads as expired, so it is taken
// over rather than wedging the slot.
function slotExpiresAtMs(value: string): number {
  const separator = value.indexOf(":");
  if (separator === -1) {
    return 0;
  }
  const expiresAt = Number(value.slice(0, separator));
  return Number.isFinite(expiresAt) ? expiresAt : 0;
}

/**
 * Claim the hourly slot, returning this execution's token, or null when the
 * slot is held by a live claim (or a racer wins the same transition). Both
 * claim shapes are single compareAndSet transitions on the exact observed
 * value, so two ticks can never both win: null → token for an empty slot,
 * staleValue → token for an expired one.
 */
async function claimEarnCatalogueSyncSlot(cache: KVStore): Promise<string | null> {
  const token = makeSlotToken();
  const existing = await cache.get(EARN_CATALOGUE_SYNC_SLOT_KEY);
  if (existing === null) {
    const won = await cache.compareAndSet(EARN_CATALOGUE_SYNC_SLOT_KEY, null, token);
    return won ? token : null;
  }
  if (slotExpiresAtMs(existing) > Date.now()) {
    return null;
  }
  const won = await cache.compareAndSet(EARN_CATALOGUE_SYNC_SLOT_KEY, existing, token);
  return won ? token : null;
}
