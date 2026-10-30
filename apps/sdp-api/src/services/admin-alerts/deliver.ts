/**
 * Sends admin alert emails (HOO-2299) through Iterable, after the alerts commit and outside any
 * transaction. Iterable takes no idempotency key, so each delivery row records its own send:
 * a run claims a row for a lease before it sends, marks it sent once Iterable accepts it, and a
 * retry only ever picks rows still unsent. A send whose acceptance is lost before the mark (a
 * timeout, a crash) is the one case that can email an admin twice.
 */
import { z } from "zod";
import { getDb } from "@/db/client";
import { parsePostgresJson } from "@/db/postgres-utils";
import { getLogger } from "@/runtime/logger";
import { iterableEmailConfig, sendIterableEmail } from "@/services/iterable-email";
import type { Env } from "@/types/env";
import { ADMIN_ALERT_KINDS, adminAlertDetailsSchema, adminAlertEmail } from "./content";
import { ADMIN_ALERT_MAX_AGE_MS } from "./enqueue";

/** Deliveries claimed per run. */
export const ADMIN_ALERT_DELIVERY_BATCH = 50;
/** Attempts before a delivery is abandoned. */
export const ADMIN_ALERT_MAX_ATTEMPTS = 8;
/** How long a claim holds a delivery: far above one send's 10 s timeout. */
const CLAIM_LEASE_MS = 5 * 60_000;
/** The wait after the first failure, doubling per attempt up to an hour. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

const claimedDeliverySchema = z.object({
  alert_id: z.string(),
  user_id: z.string(),
  email: z.string(),
  attempts: z.coerce.number().int(),
  kind: z.enum(ADMIN_ALERT_KINDS),
  details: z.unknown(),
  occurred_at: z.string(),
});

const dashboardUrlSchema = z
  .string()
  .trim()
  .pipe(z.url({ protocol: /^https?$/ }));

/**
 * Alerts run only where Iterable is configured and the dashboard has a URL to link to: prod. On
 * dev and stage there is no Iterable key, so the cron never registers, nothing is written and
 * nothing retries. A mounted `placeholder` reads as unconfigured, like a missing key.
 */
export function adminAlertEmailsEnabled(env: Env): boolean {
  return (
    iterableEmailConfig(env) !== null && dashboardUrlSchema.safeParse(env.FRONTEND_URL).success
  );
}

/**
 * Abandons what can no longer be sent usefully, claims a batch of unsent deliveries, and sends
 * each one.
 *
 * @returns How many were sent, failed (to be retried), and abandoned.
 */
export async function deliverAdminAlerts(
  env: Env,
  now: Date = new Date()
): Promise<{ sent: number; failed: number; abandoned: number }> {
  const dashboardOrigin = new URL(dashboardUrlSchema.parse(env.FRONTEND_URL)).origin;
  const db = getDb(env);
  const nowIso = now.toISOString();

  const abandoned = await db.execute(
    `UPDATE admin_alert_deliveries
        SET abandoned_at = ?, claimed_until = NULL
      WHERE sent_at IS NULL AND abandoned_at IS NULL
        AND (claimed_until IS NULL OR claimed_until < ?)
        AND (attempts >= ? OR created_at < ?)`,
    [
      nowIso,
      nowIso,
      ADMIN_ALERT_MAX_ATTEMPTS,
      new Date(now.getTime() - ADMIN_ALERT_MAX_AGE_MS).toISOString(),
    ]
  );
  if (abandoned > 0) {
    getLogger().error(
      { event: "sdp_admin_alert_deliveries_abandoned", abandoned },
      "admin alert emails abandoned after repeated failures or age"
    );
  }

  const claimed = await db.queryMany<Record<string, unknown>>(
    `WITH due AS (
       SELECT alert_id, user_id
         FROM admin_alert_deliveries
        WHERE sent_at IS NULL AND abandoned_at IS NULL
          AND (claimed_until IS NULL OR claimed_until < ?)
        ORDER BY created_at
        LIMIT ?
        FOR UPDATE SKIP LOCKED
     ),
     claimed AS (
       UPDATE admin_alert_deliveries d
          SET claimed_until = ?, attempts = d.attempts + 1
         FROM due
        WHERE d.alert_id = due.alert_id AND d.user_id = due.user_id
        RETURNING d.alert_id, d.user_id, d.email, d.attempts
     )
     SELECT claimed.*, a.kind, a.details, a.occurred_at
       FROM claimed
       JOIN admin_alerts a ON a.id = claimed.alert_id`,
    [nowIso, ADMIN_ALERT_DELIVERY_BATCH, new Date(now.getTime() + CLAIM_LEASE_MS).toISOString()]
  );

  let sent = 0;
  let failed = 0;
  for (const raw of claimed) {
    const delivery = claimedDeliverySchema.parse(raw);
    try {
      const details = adminAlertDetailsSchema.parse(
        typeof delivery.details === "string"
          ? parsePostgresJson<unknown>(delivery.details)
          : delivery.details
      );
      await sendIterableEmail(env, {
        to: delivery.email,
        ...adminAlertEmail({
          kind: delivery.kind,
          details,
          occurredAt: delivery.occurred_at,
          dashboardOrigin,
        }),
      });
      await db.execute(
        `UPDATE admin_alert_deliveries
            SET sent_at = ?, claimed_until = NULL, last_error = NULL
          WHERE alert_id = ? AND user_id = ? AND sent_at IS NULL`,
        [new Date().toISOString(), delivery.alert_id, delivery.user_id]
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      const retryInMs = Math.min(RETRY_BASE_MS * 2 ** (delivery.attempts - 1), RETRY_MAX_MS);
      await db.execute(
        `UPDATE admin_alert_deliveries
            SET claimed_until = ?, last_error = ?
          WHERE alert_id = ? AND user_id = ? AND sent_at IS NULL`,
        [
          new Date(now.getTime() + retryInMs).toISOString(),
          error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          delivery.alert_id,
          delivery.user_id,
        ]
      );
      getLogger().warn(
        {
          event: "sdp_admin_alert_delivery_failed",
          alertId: delivery.alert_id,
          attempts: delivery.attempts,
          error,
        },
        "admin alert email failed; it is retried"
      );
    }
  }
  return { sent, failed, abandoned };
}
