// Retention purge scheduling — mirrors workflow-secret-retirements' two execution
// paths: an in-process node-cron registration for self-hosted runtimes, and an IfDue
// wrapper for the managed Cloud Run job (which ticks every five minutes, far more
// often than a purge needs). The purge is idempotent, so the daily slot is a plain
// date-window claim: a lost race or crashed run costs one skipped day at worst, and
// two ticks purging the same day would merely both delete-nothing.

import type { BackgroundRunner } from "@/runtime/background";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import type { Observability } from "@/runtime/observability";
import { purgeExpiredRetentionRows } from "@/services/jobs/purge-retention";
import type { Env } from "@/types/env";

export const RETENTION_PURGE_MONITOR = "sdp-api-retention-purge";
// Once a day, off-peak. Retention windows are measured in months; tighter schedules
// would only re-scan tables that lose a day of rows at a time.
export const RETENTION_PURGE_CRON = "30 4 * * *";

const RETENTION_PURGE_SLOT_KEY = "cron:retention-purge:day";

export interface RetentionPurgeDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runRetentionPurge(deps: RetentionPurgeDeps): void {
  const work = () => purgeExpiredRetentionRows(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(RETENTION_PURGE_MONITOR, work, {
        schedule: { type: "crontab", value: RETENTION_PURGE_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}

/**
 * Cloud Run job path: claim today's UTC date in Redis; only the winning tick purges.
 */
export async function runRetentionPurgeIfDue(
  env: Env,
  observability?: Observability
): Promise<"purged" | "skipped"> {
  const cache = createKVStoreSet(env).cache;
  const today = new Date().toISOString().slice(0, 10);
  const current = await cache.get(RETENTION_PURGE_SLOT_KEY);
  if (current === today) {
    return "skipped";
  }
  if (!(await cache.compareAndSet(RETENTION_PURGE_SLOT_KEY, current, today))) {
    getLogger().info("retention purge: daily slot lost to a concurrent tick, skipping");
    return "skipped";
  }

  const work = () => purgeExpiredRetentionRows(env);
  if (observability) {
    await observability.withMonitor(RETENTION_PURGE_MONITOR, work, {
      schedule: { type: "crontab", value: RETENTION_PURGE_CRON },
    });
  } else {
    await work();
  }
  return "purged";
}
