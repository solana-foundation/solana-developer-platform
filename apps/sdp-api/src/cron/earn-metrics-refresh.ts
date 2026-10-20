/**
 * Earn strategy METRICS refresh — the fast half of the catalogue.
 *
 * The catalogue sync (`earn-catalogue-sync.ts`) runs hourly because catalogue
 * DRIFT is slow: a provider onboarding or delisting a vault. Rates are not
 * slow. An APY on a comparison table is a number a customer compares vaults by
 * and then moves money on, and an hour-old one is not that number. So the
 * volatile figures get their own frequent pass, while identity, mints,
 * liquidity terms and admission to the catalogue stay hourly. It runs every
 * five minutes as a Cron Definition (ADR 0011).
 *
 * Two properties keep the two passes from fighting:
 *
 * - **This pass can only UPDATE.** `updateStrategyMetrics` matches on
 *   (provider, provider_reference, environment) and no-ops when nothing
 *   matches, so a provider reporting figures for a vault the catalogue refused
 *   cannot admit it. Every admission gate stays in the hourly sync.
 * - **It cannot change what a strategy IS.** The input carries the rate and
 *   volatile risk metadata and nothing else, and the metadata is MERGED so
 *   slow-moving fields the sync owns (curator above all) survive.
 *
 * Participation is by capability (`supportsLiveMetrics`), so this is a registry
 * change and never a named list. For why this is a write pass rather than a
 * live read, and which providers should not implement it, see
 * `EarnLiveMetricsProvider` in @sdp/earn/types.
 *
 * **Every provider read is bounded** (`EARN_PROVIDER_METRICS_DEADLINE_MS`), so
 * one slow provider costs only its own figures: the pass moves on to the next
 * provider instead of inheriting the stall, and the Worker's overlap guard
 * skips slots for as long as a pass is still running.
 */

import { EARN_PROVIDER_CLIENTS } from "@sdp/earn";
import { supportsLiveMetrics } from "@sdp/earn/capabilities";
import { SdpEarnError } from "@sdp/earn/errors";
import type {
  EarnLiveMetricsProvider,
  EarnRuntimeContext,
  ProviderStrategyMetrics,
} from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { EarnRepository } from "@/db/repositories/earn.repository";
import { createEarnRepository } from "@/db/repositories/repository-factory";
import { isEarnEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { logVendorCallFailure } from "@/runtime/vendor-calls";
import { reportFigureAnomalies } from "@/services/earn/catalogue-anomaly";
import { guardDepositMints } from "@/services/earn/deposit-mint-guard";
import { earnClusterFor } from "@/services/earn/execution-registry";
import type { Env } from "@/types/env";
import { defineCron } from "./define-cron";

/**
 * Five minutes: the shortest cadence that is
 * unambiguously polite to a public API (Kamino's whole shelf is two requests,
 * so this is 24 requests an hour per environment) while putting a hard ceiling
 * on how stale a quoted rate can be.
 * Vault APYs move with underlying reserve utilisation — meaningfully over
 * hours, not over minutes — so five minutes is comfortably inside the noise and
 * there is nothing to gain from going lower.
 */
const EARN_METRICS_REFRESH_CRON = "*/5 * * * *";

// Matches the catalogue sync: rows are environment-scoped, so each provider
// refreshes once per environment, reading that environment's OWN shelf.
//
// The mirrored mainnet rows a non-production environment holds since PRO-1742
// are deliberately NOT covered by this pass: `updateStrategyMetrics` matches
// the bare (provider, reference, environment) triple, so writing production's
// figures into sandbox would need the same cluster-collision protection as the
// sync's mirror lane. Accepted trade-off instead: the mirror lane re-upserts
// production's accepted snapshots (currentApy and riskMetadata included) every
// HOURLY pass, so a mirrored row's figures are up to an hour stale beside its
// five-minute-fresh production twin, fine for a browse-only, fundable:false
// review shelf. (A provider whose catalogue snapshots omit the optional
// currentApy would mirror with no rate at all; none does today.)
const REFRESHED_ENVIRONMENTS: readonly SdpEnvironment[] = ["sandbox", "production"];

// Expected steady states, not incidents — same taxonomy as the catalogue sync.
const SKIPPABLE_REFRESH_ERROR_CODES: ReadonlySet<string> = new Set([
  "NOT_IMPLEMENTED",
  "PROVIDER_NOT_CONFIGURED",
]);

/**
 * Outer bound on ONE provider's read, per environment.
 *
 * Provider clients cap each HTTP request of their own (Kamino:
 * `KAMINO_REQUEST_TIMEOUT_MS`), but a per-request cap does not bound a read
 * that makes many requests — a server echoing a pagination token forever is
 * twenty prompt responses, not one slow one. This is the bound on the pass.
 *
 * Sized against the cadence, not the provider. With two environments and one
 * live-metrics provider today, 20s each caps the refresh at 40s, inside its
 * five-minute slot. Measured, a real pass is ~1.4s — this is a backstop, not a
 * budget anything runs near.
 *
 * Raising the provider count means re-checking that
 * `providers × environments × this` still clears the five-minute cadence.
 */
export const EARN_PROVIDER_METRICS_DEADLINE_MS = 20_000;

/**
 * Resolve to `undefined` if `work` outruns the deadline, so the caller can move
 * on to the next provider instead of inheriting its stall.
 *
 * The loser is deliberately not cancelled: `listStrategyMetrics` takes no
 * signal (the provider contract has no cancellation seam, and adding one for a
 * backstop would put it in every client). The abandoned request is already
 * capped by the client's own per-request timeout, so it expires on its own —
 * but its rejection is swallowed
 * here, or an orphan would surface as an unhandled rejection well after the
 * pass that started it has been logged and moved past.
 */
async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), deadlineMs);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshEarnStrategyMetrics(env: Env): Promise<void> {
  const repo = createEarnRepository(env);
  const providerEnv = env;

  for (const environment of REFRESHED_ENVIRONMENTS) {
    for (const client of Object.values(EARN_PROVIDER_CLIENTS)) {
      // Capability, not a provider list: a provider joins this pass by
      // implementing `listStrategyMetrics`.
      if (!supportsLiveMetrics(client)) {
        continue;
      }
      await refreshProviderMetrics(repo, client, { env: providerEnv, environment });
    }
  }

  // Deposit-mint extension guard (PRO-1962) rides this pass because its cadence
  // is the point: Kora co-signs PYUSD and USDG movements under
  // `transfer_hook_policy = "allow_all"`, so a hook program appearing on either
  // mint should reach a human within minutes, not at the next hourly sync. A
  // handful of account reads per cluster; report-only, never throws.
  for (const environment of REFRESHED_ENVIRONMENTS) {
    await guardDepositMints(env, earnClusterFor(environment));
  }
}

async function refreshProviderMetrics(
  repo: EarnRepository,
  client: EarnLiveMetricsProvider,
  ctx: EarnRuntimeContext
): Promise<void> {
  const logContext = { provider: client.provider, environment: ctx.environment };

  let metrics: ProviderStrategyMetrics[] | undefined;
  const startedAt = Date.now();
  try {
    metrics = await withDeadline(
      client.listStrategyMetrics(ctx),
      EARN_PROVIDER_METRICS_DEADLINE_MS
    );
  } catch (err) {
    if (err instanceof SdpEarnError && SKIPPABLE_REFRESH_ERROR_CODES.has(err.code)) {
      getLogger().info(
        { ...logContext, code: err.code },
        "refreshEarnStrategyMetrics: provider metrics skipped"
      );
      return;
    }
    // Degrades per provider, exactly like the catalogue sync: one provider's
    // outage must not cost every other provider its refresh. The rows keep
    // their last-known figures until the next frequent tick, not for an hour.
    logVendorCallFailure(client.provider, "listStrategyMetrics", err, startedAt);
    getLogger().error(
      { ...logContext, error: err instanceof Error ? err.message : String(err) },
      "refreshEarnStrategyMetrics: failed to list provider metrics"
    );
    return;
  }

  if (metrics === undefined) {
    logVendorCallFailure(
      client.provider,
      "listStrategyMetrics",
      new Error(`provider metrics exceeded the ${EARN_PROVIDER_METRICS_DEADLINE_MS}ms deadline`),
      startedAt
    );
    // Logged at error, not warn: the whole point of this pass is to bound rate
    // freshness with a frequent cadence. A provider that cannot answer inside
    // the deadline is not meeting that contract, even though its rows keep
    // their last-known figures and every other provider still refreshes.
    getLogger().error(
      { ...logContext, deadlineMs: EARN_PROVIDER_METRICS_DEADLINE_MS },
      "refreshEarnStrategyMetrics: provider metrics exceeded the deadline"
    );
    return;
  }

  // Figure anomaly check (PRO-1867) against the stored shelf BEFORE the
  // writes. Read-only and never fatal; entries for references the catalogue
  // does not hold are skipped exactly as the update below no-ops on them.
  let anomalies = 0;
  try {
    const stored = await repo.listStrategyFigures({
      provider: client.provider,
      environment: ctx.environment,
    });
    anomalies = reportFigureAnomalies({
      source: "metrics_refresh",
      provider: client.provider,
      environment: ctx.environment,
      stored: stored.map((row) => ({
        providerReference: row.provider_reference,
        hostCluster: row.host_cluster,
        currentApy: row.current_apy,
        tvlUsd: row.tvl_usd,
      })),
      incoming: metrics.map((entry) => ({
        providerReference: entry.providerReference,
        currentApy: entry.currentApy ?? null,
        tvlUsd: entry.riskMetadata?.tvlUsd,
      })),
    });
  } catch (err) {
    getLogger().warn(
      { ...logContext, error: err instanceof Error ? err.message : String(err) },
      "refreshEarnStrategyMetrics: skipped figure anomaly check, stored figures unreadable"
    );
  }

  let updated = 0;
  let failed = 0;
  const updates = metrics.map((entry) => ({
    provider: client.provider,
    providerReference: entry.providerReference,
    environment: ctx.environment,
    // Explicit null, not undefined: a provider that stops reporting a rate
    // must clear the stored one rather than leave a figure with no source.
    currentApy: entry.currentApy ?? null,
    riskMetadata: entry.riskMetadata ?? {},
  }));
  try {
    updated = await repo.updateStrategyMetricsBatch(updates);
  } catch (batchError) {
    getLogger().warn(
      {
        ...logContext,
        strategies: updates.length,
        error: batchError instanceof Error ? batchError.message : String(batchError),
      },
      "refreshEarnStrategyMetrics: batch update failed, retrying strategies separately"
    );
    for (const update of updates) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- fallback isolates the provider row that broke the atomic batch.
        const applied = await repo.updateStrategyMetrics(update);
        if (applied) updated += 1;
      } catch (err) {
        failed += 1;
        getLogger().error(
          {
            ...logContext,
            provider_reference: update.providerReference,
            error: err instanceof Error ? err.message : String(err),
          },
          "refreshEarnStrategyMetrics: failed to update strategy metrics"
        );
      }
    }
  }

  // `reported` far exceeding `updated` is normal, not a warning: a provider
  // hands over its whole shelf and the catalogue holds only the part that
  // cleared the admission gates.
  getLogger().info(
    { ...logContext, reported: metrics.length, updated, failed, anomalies },
    "refreshEarnStrategyMetrics: refreshed provider metrics"
  );
}

/** Volatile Earn figures (APY, TVL, risk metadata) for strategies the catalogue already admitted. */
export const earnMetricsRefreshCron = defineCron({
  name: "refresh-earn-metrics",
  schedule: EARN_METRICS_REFRESH_CRON,
  scope: "global",
  effect: "observes",
  enabled: isEarnEnabled,
  run: refreshEarnStrategyMetrics,
});
