// Retention purge for the append-only operational tables that otherwise grow forever:
// in-app notifications (one row per event × recipient), email-delivery idempotency
// claims, and the per-attempt webhook delivery log (whose migration documented this
// exact job as deferred). Everything here is idempotent — deleting expired rows twice
// is harmless — so callers need at-most-daily cadence, not mutual exclusion.

import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

export const RETENTION_DAYS = {
  // A read notification has served its purpose; unread rows get double the window so
  // an infrequent user's inbox doesn't evaporate before they return.
  notificationsRead: 90,
  notificationsUnread: 180,
  // Purging a 'sent' claim re-opens the email idempotency window for its dedupe key —
  // 60 days exceeds any plausible webhook replay/redelivery horizon many times over.
  notificationDeliveries: 60,
  // Per-attempt webhook audit log; matches the delivery claims' window.
  webhookDeliveries: 60,
} as const;

// Bounded deletes: a first run over a long backlog must not hold wide row locks or
// balloon a single statement. Loops until a batch comes back short.
const PURGE_BATCH_SIZE = 5_000;

export interface RetentionPurgeResult {
  notificationsRead: number;
  notificationsUnread: number;
  notificationDeliveries: number;
  webhookDeliveries: number;
}

function cutoffIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function purgeBatched(env: Env, sql: string, cutoff: string): Promise<number> {
  const db = getDb(env);
  let total = 0;
  for (;;) {
    const affected = await db.prepare(sql).bind(cutoff, PURGE_BATCH_SIZE).run();
    total += affected;
    if (affected < PURGE_BATCH_SIZE) {
      return total;
    }
  }
}

export async function purgeExpiredRetentionRows(
  env: Env,
  now: Date = new Date()
): Promise<RetentionPurgeResult> {
  // TEXT ISO timestamps compare lexicographically, so `created_at < ?` with an ISO
  // cutoff is exact. Postgres DELETE has no LIMIT — batch via an id subquery.
  const result: RetentionPurgeResult = {
    notificationsRead: await purgeBatched(
      env,
      `DELETE FROM notifications WHERE id IN (
         SELECT id FROM notifications WHERE read_at IS NOT NULL AND created_at < ? LIMIT ?)`,
      cutoffIso(now, RETENTION_DAYS.notificationsRead)
    ),
    notificationsUnread: await purgeBatched(
      env,
      `DELETE FROM notifications WHERE id IN (
         SELECT id FROM notifications WHERE read_at IS NULL AND created_at < ? LIMIT ?)`,
      cutoffIso(now, RETENTION_DAYS.notificationsUnread)
    ),
    // Keyed on updated_at, not created_at: a reclaimed 'failed' row is live activity
    // and its idempotency window should restart from the latest attempt.
    notificationDeliveries: await purgeBatched(
      env,
      `DELETE FROM notification_deliveries WHERE id IN (
         SELECT id FROM notification_deliveries WHERE updated_at < ? LIMIT ?)`,
      cutoffIso(now, RETENTION_DAYS.notificationDeliveries)
    ),
    // redelivery_of is ON DELETE SET NULL, so purging originals is reference-safe.
    webhookDeliveries: await purgeBatched(
      env,
      `DELETE FROM webhook_deliveries WHERE id IN (
         SELECT id FROM webhook_deliveries WHERE created_at < ? LIMIT ?)`,
      cutoffIso(now, RETENTION_DAYS.webhookDeliveries)
    ),
  };
  getLogger().info(result, "retention purge completed");
  return result;
}
