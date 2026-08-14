/**
 * Earn strategy METRICS refresh — the fast half of the catalogue.
 *
 * The catalogue sync (`earn-catalogue-sync.ts`) runs hourly because catalogue
 * DRIFT is slow: a provider onboarding or delisting a vault. Rates are not
 * slow. An APY on a comparison table is a number a customer compares vaults by
 * and then moves money on, and an hour-old one is not that number. So the
 * volatile figures get their own pass on a five-minute cadence, while identity,
 * mints, liquidity terms and admission to the catalogue stay hourly.
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
 */

import { EARN_PROVIDER_CLIENTS, SdpEarnError, supportsLiveMetrics } from "@sdp/earn";
import type {
  EarnLiveMetricsProvider,
  EarnRuntimeContext,
  ProviderStrategyMetrics,
} from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import { createEarnRepository, type EarnRepository } from "@/db/repositories";
import type { BackgroundRunner } from "@/runtime/background";
import { getLogger } from "@/runtime/logger";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";

export const EARN_METRICS_REFRESH_MONITOR = "sdp-api-refresh-earn-metrics";

/**
 * Five minutes: the shortest cadence that is unambiguously polite to a public
 * API (Kamino's whole shelf is two requests, so this is 24 requests an hour per
 * environment) while putting a hard ceiling on how stale a quoted rate can be.
 * Vault APYs move with underlying reserve utilisation — meaningfully over
 * hours, not over minutes — so five minutes is comfortably inside the noise and
 * there is nothing to gain from going lower.
 */
export const EARN_METRICS_REFRESH_CRON = "*/5 * * * *";

// Matches the catalogue sync: rows are environment-scoped, so each provider
// refreshes once per environment. A mainnet-only provider is catalogued into
// both, and its rows in both want the same fresh figures.
const REFRESHED_ENVIRONMENTS: readonly SdpEnvironment[] = ["sandbox", "production"];

// Expected steady states, not incidents — same taxonomy as the catalogue sync.
const SKIPPABLE_REFRESH_ERROR_CODES: ReadonlySet<string> = new Set([
  "NOT_IMPLEMENTED",
  "PROVIDER_NOT_CONFIGURED",
]);

export async function refreshEarnStrategyMetrics(env: Env): Promise<void> {
  const repo = createEarnRepository(env);
  const providerEnv = env as unknown as Record<string, string | undefined>;

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
}

async function refreshProviderMetrics(
  repo: EarnRepository,
  client: EarnLiveMetricsProvider,
  ctx: EarnRuntimeContext
): Promise<void> {
  const logContext = { provider: client.provider, environment: ctx.environment };

  let metrics: ProviderStrategyMetrics[];
  try {
    metrics = await client.listStrategyMetrics(ctx);
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
    // their last-known figures until the next tick — five minutes, not an hour.
    getLogger().error(
      { ...logContext, error: err instanceof Error ? err.message : String(err) },
      "refreshEarnStrategyMetrics: failed to list provider metrics"
    );
    return;
  }

  let updated = 0;
  let failed = 0;
  for (const entry of metrics) {
    try {
      const applied = await repo.updateStrategyMetrics({
        provider: client.provider,
        providerReference: entry.providerReference,
        environment: ctx.environment,
        // Explicit null, not undefined: a provider that stops reporting a rate
        // must clear the stored one rather than leave a figure that no longer
        // has a source behind it.
        currentApy: entry.currentApy ?? null,
        riskMetadata: entry.riskMetadata ?? {},
      });
      if (applied) {
        updated += 1;
      }
    } catch (err) {
      failed += 1;
      getLogger().error(
        {
          ...logContext,
          provider_reference: entry.providerReference,
          error: err instanceof Error ? err.message : String(err),
        },
        "refreshEarnStrategyMetrics: failed to update strategy metrics"
      );
    }
  }

  // `reported` far exceeding `updated` is normal, not a warning: a provider
  // hands over its whole shelf and the catalogue holds only the part that
  // cleared the admission gates.
  getLogger().info(
    { ...logContext, reported: metrics.length, updated, failed },
    "refreshEarnStrategyMetrics: refreshed provider metrics"
  );
}

export interface EarnMetricsRefreshDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runEarnMetricsRefresh(deps: EarnMetricsRefreshDeps): void {
  // Reuses the managed tick verbatim, which the catalogue sync deliberately
  // cannot: ITS tick claims a Redis slot the in-process scheduler must not
  // touch, so the two paths there differ. This pass is unslotted (see the
  // tick's docstring), leaving nothing for the two to disagree about.
  //
  // `runEarnMetricsRefreshTick` is async, so a throw before its first await is
  // already a rejected promise the BackgroundRunner can track rather than one
  // propagating into the runtime entrypoint — the invariant the hand-rolled
  // `Promise.resolve().then(work)` used to buy.
  deps.bg.run(runEarnMetricsRefreshTick(deps.env, deps.observability));
}

/**
 * One tick of the managed Cloud Run Job (`src/job.ts`).
 *
 * Deliberately UNSLOTTED, unlike the catalogue sync. That job already ticks
 * every five minutes, which is exactly this pass's cadence, so there is no
 * window to claim — the job's own schedule is the schedule. Two overlapping
 * executions would at worst write the same figures twice, which is harmless
 * here in a way a duplicated catalogue pass (with its delist half) is not.
 *
 * Callers gate on isEarnEnabled first, mirroring the catalogue sync.
 */
export async function runEarnMetricsRefreshTick(
  env: Env,
  observability?: Observability
): Promise<void> {
  const work = () => refreshEarnStrategyMetrics(env);
  await (observability
    ? observability.withMonitor(EARN_METRICS_REFRESH_MONITOR, work, {
        schedule: { type: "crontab", value: EARN_METRICS_REFRESH_CRON },
      })
    : work());
}
