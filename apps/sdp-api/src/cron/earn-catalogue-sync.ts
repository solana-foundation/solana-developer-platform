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
 *   each deployment-scheduled tick claims an hourly Redis slot first and skips
 *   quietly when the slot is held — the catalogue cadence stays
 *   `EARN_CATALOGUE_SYNC_CRON` no matter how often the job runs.
 *
 * The sync iterates every registered vault-infra provider, pulls each of its
 * live strategy catalogues, and upserts them into `earn_strategies` keyed on
 * (provider, provider_reference, environment) — the only admitting writer for
 * that table. Since PRO-1742 a non-production environment is written as TWO
 * lanes: the provider's own catalogue for that environment, plus a browse-only
 * MIRROR of the production pass's accepted mainnet shelf, so the curated
 * mainnet catalogue can be reviewed outside production
 * (`isClusterFundableInEnvironment` is what keeps the mirrored rows
 * un-depositable — the reads derive `fundable: false` and every provider
 * mutation asserts the same predicate). Each lane then DELISTS within the
 * cluster sub-shelf it is the truth for (`deleteUnlistedFromCatalogue`), so the
 * table converges on the live catalogues instead of only ever growing — that
 * is what makes a tightened catalogue gate reach rows already stored — without
 * one lane's keep set tearing down the other lane's shelf. It degrades
 * provider-by-provider: one provider failing (or still being a NOT_IMPLEMENTED
 * stub) must never sink the others' pass. Adding a provider is a registry
 * change only (`EARN_PROVIDER_CLIENTS`) — neither execution path names
 * providers.
 */

import { randomUUID } from "node:crypto";
import { EARN_PROVIDER_CLIENTS, isStrategyWithinDeclaredSupport, SdpEarnError } from "@sdp/earn";
import type {
  EarnRuntimeContext,
  EarnVaultProvider,
  ProviderStrategySnapshot,
} from "@sdp/earn/types";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SdpEnvironment, type SolanaCluster } from "@sdp/types";
import { createEarnRepository, type EarnRepository } from "@/db/repositories";
import type { BackgroundRunner } from "@/runtime/background";
import type { KVStore } from "@/runtime/kv";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import type { Observability } from "@/runtime/observability";
import { logVendorCallFailure } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";

export const EARN_CATALOGUE_SYNC_MONITOR = "sdp-api-sync-earn-catalogue";
// Catalogue drift is slow (a provider onboarding or delisting a vault), so
// hourly keeps rows fresh without hammering provider APIs.
export const EARN_CATALOGUE_SYNC_CRON = "0 * * * *";

// The managed Cloud Run Job ticks at its deployment-provided cadence, more
// often than the hourly cadence above. Each tick claims this Redis slot first,
// so exactly one tick per window syncs and overlapping executions lose cleanly.
//
// The slot value is a unique claim token that embeds its own expiry
// (`<expiresAtEpochMs>:<uuid>`), and every transition is atomic on the exact
// prior value: an empty slot is claimed with compareAndSet(null → token), an
// expired one is taken over with compareAndSet(staleValue → token), and a
// failed sync releases with compareAndDelete(token) — which is a server-side
// no-op unless the claim still belongs to this execution, so a sync that
// outlives its slot can never delete a newer tick's claim. The expiry sits
// just under the hour so the next managed tick after expiry claims a fresh
// slot; a job that dies mid-sync self-heals once the token expires (worst case:
// one skipped window).
export const EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS = 3540;
const EARN_CATALOGUE_SYNC_SLOT_KEY = "cron:earn-catalogue-sync:slot";
const EARN_CATALOGUE_DISABLED_MONITOR_SLOT_KEY = "cron:earn-catalogue-sync:disabled-monitor-slot";

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
// devnet mints, production rows mainnet mints), so each provider syncs once per
// environment — plus, in every non-production environment, the mirrored
// production mainnet shelf (PRO-1742).
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
  const providerEnv = env;

  for (const client of Object.values(EARN_PROVIDER_CLIENTS)) {
    await syncProviderCatalogue(repo, client, providerEnv);
  }
}

/**
 * One provider, every environment. Production is fetched FIRST because its
 * accepted snapshots serve twice: as production's own catalogue, and as the
 * mirror source for every non-production environment (PRO-1742). One fetch per
 * data source per pass — the mirror is a second WRITE, never a second read of
 * the provider.
 */
async function syncProviderCatalogue(
  repo: EarnRepository,
  client: EarnVaultProvider,
  env: Env
): Promise<void> {
  const production = await fetchAcceptedSnapshots(client, { env, environment: "production" });
  if (production.ok) {
    // The provider's own fetch is the total truth for production, so its
    // delist stays environment-wide and stray wrong-cluster rows converge away
    // (a devnet row reaching production is otherwise caught only at read time,
    // by isClusterFundableInEnvironment — see @sdp/earn support.ts).
    await writeCatalogueLane(repo, client, {
      environment: "production",
      snapshots: production.snapshots,
      delistScope: undefined,
    });
  }

  for (const environment of SYNCED_ENVIRONMENTS) {
    if (environment === "production") {
      continue;
    }
    await syncNonProductionEnvironment(repo, client, env, environment, production);
  }
}

/**
 * A non-production environment holds TWO lanes since PRO-1742, each with its
 * own truth source and its own cluster-scoped delist:
 *
 * - the provider's OWN catalogue for this environment — the fundable shelf;
 * - a browse-only MIRROR of production's accepted mainnet shelf, so the
 *   curated catalogue can be reviewed in the surface that offers it without
 *   doing that review in production. Mirrored rows arrive `fundable: false` on
 *   every read and every provider-mutation gate refuses them
 *   (isClusterFundableInEnvironment) — the honesty the old persistence guard
 *   protected lives in the read model and the UI now.
 *
 * The lanes stay independent on purpose: a mirror-source failure must not stop
 * the environment's own shelf from converging, and a mirror pass must never
 * delist the own lane's rows — its keep set knows nothing about them. That is
 * what `delistScope` is for.
 *
 * A reference MIGRATING between lanes (collided last pass, devnet-delisted
 * this pass) briefly leans on both: the own lane truthfully deletes its devnet
 * row, and the mirror lane rewrites the reference as mainnet. If that mirror
 * write fails, the row is simply ABSENT until a later pass succeeds — accepted
 * staleness, chosen deliberately over protecting the devnet row from its own
 * delist, which would keep a vault the provider DELISTED sitting
 * `fundable: true` for an hour. An hour without a browse-only mirror row beats
 * an hour offering a delisted vault a deposit path.
 *
 * The mirror carries the provider SNAPSHOT, not production's stored row: an
 * operator `paused`/`deprecated` set on the production row does not propagate
 * here (the sandbox mirror row stays visibly active while production hides
 * its own). Curation-by-hiding does propagate (the cluster-keyed hidden and
 * curated vault sets ride the accepted snapshots), and safety holds regardless
 * (`fundable: false` throughout), so this is a known fidelity gap of the
 * review surface, not a deposit path.
 */
async function syncNonProductionEnvironment(
  repo: EarnRepository,
  client: EarnVaultProvider,
  env: Env,
  environment: SdpEnvironment,
  production: CatalogueFetch
): Promise<void> {
  const logContext = { provider: client.provider, environment };

  const own = await fetchAcceptedSnapshots(client, { env, environment });
  if (!own.ok && !own.steadyState) {
    // No reliable read of the environment's own shelf: write nothing here. The
    // mirror lane needs the own reference set too (collision rule below), so it
    // skips along with it — one hour of staleness, never a wrong write.
    return;
  }
  // A steady-state own skip (stub, or no credentials for THIS environment) is
  // a reliable "this environment has no own shelf", not an outage: the own
  // lane writes nothing, and the mirror lane proceeds with an empty reference
  // set. That is what lets a MAINNET-ONLY provider (arguably the provider
  // class the mirror exists for) be mirrored at all.

  const environmentCluster = CLUSTER_BY_SDP_ENVIRONMENT[environment];

  const ownRows: ProviderStrategySnapshot[] = [];
  if (own.ok) {
    // Successor of the old "mainnet instruments never enter a non-production
    // catalogue" guard: mainnet rows now DO enter (PRO-1742), but only through
    // the mirror lane below, which carries production's accepted shelf verbatim.
    // An own-fetch snapshot on a foreign cluster is therefore provider drift —
    // flag it and let the lane that owns that cluster state the row.
    for (const snapshot of own.snapshots) {
      if (snapshot.hostCluster !== environmentCluster) {
        getLogger().warn(
          {
            ...logContext,
            provider_reference: snapshot.providerReference,
            host_cluster: snapshot.hostCluster,
          },
          "syncEarnCatalogue: dropped an own-catalogue snapshot on a foreign cluster (the mirror lane owns it)"
        );
        continue;
      }
      ownRows.push(snapshot);
    }

    await writeCatalogueLane(repo, client, {
      environment,
      snapshots: ownRows,
      delistScope: environmentCluster,
    });
  }

  if (!production.ok) {
    if (production.steadyState) {
      // A steady-state skip (stub provider, production credentials absent or
      // revoked) is a reliable "no production catalogue exists", so the mirror
      // converges to EMPTY rather than serving rows production no longer
      // vouches for. This is the only delist path a previously mirrored
      // mainnet row has once the production fetch stops succeeding.
      await writeCatalogueLane(repo, client, {
        environment,
        snapshots: [],
        delistScope: "mainnet-beta",
        allowEmptyKeepSet: true,
      });
    } else {
      // A transient failure is worth a line — the mirrored shelf keeps last
      // hour's rows until a pass can prove what production currently lists.
      getLogger().warn(
        logContext,
        "syncEarnCatalogue: mainnet mirror lane skipped — production catalogue unavailable this pass"
      );
    }
    return;
  }

  const ownReferences = new Set(ownRows.map((snapshot) => snapshot.providerReference));
  const mirrorRows: ProviderStrategySnapshot[] = [];
  const collidedReferences: string[] = [];
  for (const snapshot of production.snapshots) {
    // The mirror carries the MAINNET shelf only — the catalogue this lane
    // exists to review. The literal names the shelf's identity; it is not a
    // copy of the fundability comparison (which stays solely in
    // isClusterFundableInEnvironment).
    if (snapshot.hostCluster !== "mainnet-beta") {
      continue;
    }
    if (ownReferences.has(snapshot.providerReference)) {
      // The upsert key is (provider, reference, environment) with no cluster,
      // so a reference both sources list would flip one row between clusters
      // on alternating lanes. The environment's own (fundable) shelf wins the
      // WRITE — but the reference stays in the mirror's keep set below:
      // production still lists it, and if the own lane's upsert failed this
      // pass, the stored row is still on the mirror's cluster, where an
      // unprotected delist would read that failed write as a delisting.
      //
      // Accepted cap, recorded in ADR 0002 (PRO-1742 addendum): this skip
      // means the mirror only fully materializes for providers whose
      // references are cluster-distinct (address-keyed, like Kamino). A
      // provider keying both catalogues by a shared slug (Ground's source ids)
      // collides on every pass and its mirror under-reports by exactly those
      // references. Deliberate: extending the upsert key to the cluster would
      // double-write every bare-triple consumer (updateStrategyMetrics above
      // all).
      collidedReferences.push(snapshot.providerReference);
      getLogger().warn(
        { ...logContext, provider_reference: snapshot.providerReference },
        "syncEarnCatalogue: mirror row skipped — reference collides with the environment's own shelf"
      );
      continue;
    }
    mirrorRows.push(snapshot);
  }

  await writeCatalogueLane(repo, client, {
    environment,
    snapshots: mirrorRows,
    delistScope: "mainnet-beta",
    keepWithoutUpsert: collidedReferences,
    // Production answered reliably this pass, so an empty mainnet shelf is a
    // real all-gone delisting, not an unreadable one. The delete asymmetry
    // flips on this lane: its rows are browse-only and re-mirrored hourly, so
    // a wrong delete costs an hour of a missing browse row, while refusing to
    // delete costs serving a "production catalogue" forever that production
    // no longer lists.
    allowEmptyKeepSet: true,
  });
}

type CatalogueFetch =
  | { ok: true; snapshots: ProviderStrategySnapshot[] }
  | { ok: false; steadyState: boolean };

/**
 * One provider catalogue read, reduced to the snapshots the sync ACCEPTS —
 * declared-support filtering happens here, so every consumer of the result (a
 * lane write, the mirror) sees the same admitted set. Never throws: expected
 * steady states (stubs, missing credentials) come back as a quiet `ok: false`,
 * anything else logs an error and comes back the same way, so one provider can
 * never sink another's pass.
 */
async function fetchAcceptedSnapshots(
  client: EarnVaultProvider,
  ctx: EarnRuntimeContext
): Promise<CatalogueFetch> {
  const logContext = { provider: client.provider, environment: ctx.environment };

  let snapshots: ProviderStrategySnapshot[];
  const startedAt = Date.now();
  try {
    snapshots = await client.listStrategies(ctx);
  } catch (err) {
    if (err instanceof SdpEarnError && SKIPPABLE_SYNC_ERROR_CODES.has(err.code)) {
      getLogger().info(
        { ...logContext, code: err.code },
        "syncEarnCatalogue: provider catalogue skipped"
      );
      return { ok: false, steadyState: true };
    }
    logVendorCallFailure(client.provider, "listStrategies", err, startedAt);
    getLogger().error(
      { ...logContext, error: err instanceof Error ? err.message : String(err) },
      "syncEarnCatalogue: failed to list provider strategies"
    );
    return { ok: false, steadyState: false };
  }

  const accepted: ProviderStrategySnapshot[] = [];
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
    accepted.push(snapshot);
  }
  return { ok: true, snapshots: accepted };
}

/**
 * One write lane: the snapshots one truth source states for one environment,
 * and the cluster sub-shelf that source is allowed to delist (`delistScope`
 * undefined means the whole environment — production's own fetch).
 */
interface CatalogueLane {
  environment: SdpEnvironment;
  snapshots: readonly ProviderStrategySnapshot[];
  delistScope: SolanaCluster | undefined;
  /**
   * References this lane's truth source lists but the lane must not WRITE —
   * the mirror's collision-dropped rows. They still belong in the delist keep
   * set: the source lists them, so deleting them would turn a skipped (or
   * failed) write into a delisting.
   */
  keepWithoutUpsert?: readonly string[];
  /**
   * Authorizes this lane's delist to run with an EMPTY keep set. Own lanes
   * never set it (an empty own read is indistinguishable from a broken one,
   * and their rows are fundable). The mirror lane sets it because its truth
   * source can reliably answer "nothing is listed" and its rows are
   * browse-only; without it, orphaned mirror rows have no convergence path.
   */
  allowEmptyKeepSet?: true;
}

async function writeCatalogueLane(
  repo: EarnRepository,
  client: EarnVaultProvider,
  lane: CatalogueLane
): Promise<void> {
  const logContext = {
    provider: client.provider,
    environment: lane.environment,
    delist_scope: lane.delistScope ?? "environment",
  };

  // The keep set for the delist pass below: references this lane accepts as
  // currently-listed. Built from the accepted snapshots (plus any
  // keep-without-upsert references), not from upsert results, so a transient
  // write failure never reads as a delisting — but any upsert failure still
  // skips the pass entirely (`upsertFailed`), because a half-applied catalogue
  // cannot say what the provider no longer lists.
  const listedProviderReferences: string[] = [...(lane.keepWithoutUpsert ?? [])];
  let upsertFailed = false;

  for (const snapshot of lane.snapshots) {
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
        // Taken from the PROVIDER (production's accepted snapshot, on the
        // mirror lane), never derived from the target environment — assuming
        // the environment's cluster here is the silent lie this column exists
        // to prevent (migration 0057), and the mirror lane exists precisely
        // because the two differ.
        hostCluster: snapshot.hostCluster,
        // Providers report no status; being listed is what makes a strategy
        // depositable, so the sync submits `active` for anything a provider
        // still lists. The repository upsert refuses to overwrite an operator
        // `paused`/`deprecated` status (earn.repository.postgres.ts) — an
        // operator stop outranks the sync; only an explicit status write
        // reopens the row.
        status: "active",
        environment: lane.environment,
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

  await deleteUnlistedFromCatalogue(repo, client, lane, {
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
 *   repository refuses this too; the log here is what makes it visible),
 *   unless the lane declared its empty read reliable (`allowEmptyKeepSet`,
 *   the mirror lane), where the pass converges the sub-shelf to empty.
 *
 * A skip costs one hour of staleness. Deleting wrongly costs a customer a
 * vault they were mid-deposit into, so the asymmetry decides the default.
 *
 * The delete is scoped to the lane's cluster sub-shelf (`delistScope`): a keep
 * set only ever describes what ITS truth source lists, so letting it reach the
 * other lane's rows would delist a shelf nobody re-read this pass.
 */
async function deleteUnlistedFromCatalogue(
  repo: EarnRepository,
  client: EarnVaultProvider,
  lane: CatalogueLane,
  args: {
    listedProviderReferences: readonly string[];
    upsertFailed: boolean;
    logContext: Record<string, unknown>;
  }
): Promise<void> {
  const { listedProviderReferences, upsertFailed, logContext } = args;

  if (upsertFailed || (listedProviderReferences.length === 0 && !lane.allowEmptyKeepSet)) {
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
      environment: lane.environment,
      hostCluster: lane.delistScope,
      listedProviderReferences,
      allowEmptyKeepSet: lane.allowEmptyKeepSet,
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

export type EarnCatalogueSyncTickOutcome = "synced" | "skipped" | "disabled";

export interface EarnCatalogueSyncTickOptions {
  /**
   * False keeps an already-created managed monitor healthy while its feature
   * is disabled, without touching provider APIs or catalogue rows.
   */
  workEnabled?: boolean;
}

/**
 * One tick of the managed Cloud Run Job (`src/job.ts`): claim the hourly slot,
 * then sync under this task's own Sentry monitor. Ticks that lose the claim
 * skip without a monitor check-in. The in-process reporter uses
 * EARN_CATALOGUE_SYNC_CRON; the managed adapter represents this rolling hourly
 * lease as an interval because its phase is whichever scheduler tick first
 * wins the slot, not necessarily minute zero.
 *
 * A failed or deadline-exceeded sync releases the slot — the next managed tick
 * retries instead of waiting out the hour — and rethrows:
 * syncEarnCatalogue already degrades per provider and per row, so anything
 * escaping it is infrastructure-level and must fail the job loudly. The
 * release is compareAndDelete on this execution's claim token, so it
 * atomically no-ops if a newer tick has taken the slot over in the meantime;
 * the sync deadline (far under the claim expiry) guarantees that never
 * happens while a sync is still running.
 *
 * Managed callers can set workEnabled=false to keep an existing monitor alive
 * while Earn is disabled. That heartbeat claims a separate monitoring-only
 * lease and cannot delay later business work.
 */
export async function runEarnCatalogueSyncIfDue(
  env: Env,
  observability?: Observability,
  { workEnabled = true }: EarnCatalogueSyncTickOptions = {}
): Promise<EarnCatalogueSyncTickOutcome> {
  const cache = createKVStoreSet(env).cache;
  // A disabled-feature heartbeat has its own lease. Reusing the work lease
  // would make observability mutate admission: enabling Earn just after a
  // no-op check-in would delay the real catalogue sync for almost an hour.
  const slotKey = workEnabled
    ? EARN_CATALOGUE_SYNC_SLOT_KEY
    : EARN_CATALOGUE_DISABLED_MONITOR_SLOT_KEY;
  const claimToken = await claimEarnCatalogueSyncSlot(cache, slotKey);
  if (claimToken === null) {
    getLogger().info("syncEarnCatalogue: hourly slot already claimed, skipping this tick");
    return "skipped";
  }

  // The deadline sits inside the monitor wrapper so Sentry records an
  // exceeded run as a failed check-in rather than a forever-pending one.
  const work = workEnabled ? () => withSyncDeadline(syncEarnCatalogue(env)) : async () => undefined;
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
      await cache.compareAndDelete(slotKey, claimToken);
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
  return workEnabled ? "synced" : "disabled";
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
async function claimEarnCatalogueSyncSlot(cache: KVStore, slotKey: string): Promise<string | null> {
  const token = makeSlotToken();
  const existing = await cache.get(slotKey);
  if (existing === null) {
    const won = await cache.compareAndSet(slotKey, null, token);
    return won ? token : null;
  }
  if (slotExpiresAtMs(existing) > Date.now()) {
    return null;
  }
  const won = await cache.compareAndSet(slotKey, existing, token);
  return won ? token : null;
}
