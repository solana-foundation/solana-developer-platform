/**
 * Sends admin alert emails (HOO-2299) through Iterable, after the alerts commit and outside any
 * transaction. Iterable takes no idempotency key, so each delivery row records its own send:
 * a send claims its one row under a fresh claim id for a lease, and only that claim can mark it
 * sent or failed, so a run whose lease lapsed never settles a row another run has since claimed.
 * A send whose acceptance is lost before the mark (a timeout, a crash) is the one case that can
 * email an admin twice.
 *
 * Who gets an email is decided again at each send: a recipient who is no longer an active admin,
 * or an organization that has since turned alert emails off, suppresses it.
 */
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db/client";
import { parsePostgresJson } from "@/db/postgres-utils";
import { getLogger } from "@/runtime/logger";
import { actionUrlSchema } from "@/services/email-layout";
import { iterableEmailConfig, sendIterableEmail } from "@/services/iterable-email";
import type { Env } from "@/types/env";
import { ADMIN_ALERT_KINDS, adminAlertDetailsSchema, adminAlertEmail } from "./content";
import { ADMIN_ALERT_MAX_AGE_MS } from "./enqueue";

/** Sends per run; the rest wait for the next run. */
export const ADMIN_ALERT_DELIVERY_BATCH = 50;
/** Attempts before a delivery is abandoned. */
export const ADMIN_ALERT_MAX_ATTEMPTS = 8;
/** How long a claim holds its one delivery: far above one send's 10 s timeout. */
const CLAIM_LEASE_MS = 5 * 60_000;
/** The wait after the first failure, doubling per attempt up to an hour. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

const claimedDeliverySchema = z.object({
  alert_id: z.string(),
  user_id: z.string(),
  attempts: z.coerce.number().int(),
});

const deliveryTargetSchema = z.object({
  kind: z.enum(ADMIN_ALERT_KINDS),
  details: z.unknown(),
  occurred_at: z.string(),
  /** The recipient's address now, or null when they are no longer an active admin. */
  admin_email: z.string().nullable(),
  alert_emails: z.string().nullable(),
});

/** The dashboard every alert links to, held to the layout's own link rule. */
const dashboardUrlSchema = z.string().trim().pipe(actionUrlSchema);

/**
 * Alerts run only where Iterable is configured and the dashboard has a URL the email layout will
 * link (https, or http to localhost for local development): prod, and a local API on Doppler dev. On
 * dev and stage there is no Iterable key, so the cron never registers, nothing is written and
 * nothing retries. A mounted `placeholder` reads as unconfigured, like a missing key.
 */
export function adminAlertEmailsEnabled(env: Env): boolean {
  return (
    iterableEmailConfig(env) !== null && dashboardUrlSchema.safeParse(env.FRONTEND_URL).success
  );
}

/** Claims the oldest due delivery for one send, or returns null when none is due. */
async function claimNext(db: DatabaseExecutor, now: Date, claimId: string) {
  const nowIso = now.toISOString();
  const row = await db.queryOne<Record<string, unknown>>(
    `WITH due AS (
       SELECT alert_id, user_id
         FROM admin_alert_deliveries
        WHERE status = 'pending' AND (claimed_until IS NULL OR claimed_until < ?)
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE admin_alert_deliveries d
        SET claim_id = ?, claimed_until = ?, attempts = d.attempts + 1, updated_at = ?
       FROM due
      WHERE d.alert_id = due.alert_id AND d.user_id = due.user_id
      RETURNING d.alert_id, d.user_id, d.attempts`,
    [nowIso, claimId, new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(), nowIso]
  );
  return row ? claimedDeliverySchema.parse(row) : null;
}

/** The alert, and whether its recipient and organization still want it, read at send time. */
async function deliveryTarget(
  db: DatabaseExecutor,
  delivery: z.infer<typeof claimedDeliverySchema>
) {
  const row = await db.queryOne<Record<string, unknown>>(
    `SELECT a.kind, a.details, a.occurred_at,
            u.email AS admin_email,
            o.settings::jsonb ->> 'alertEmails' AS alert_emails
       FROM admin_alerts a
       JOIN organizations o ON o.id = a.organization_id
       LEFT JOIN organization_members om
              ON om.organization_id = a.organization_id AND om.user_id = ?
             AND om.role = 'admin' AND om.status = 'active'
       LEFT JOIN users u ON u.id = om.user_id AND u.status = 'active'
      WHERE a.id = ?`,
    [delivery.user_id, delivery.alert_id]
  );
  if (!row) throw new Error(`Admin alert ${delivery.alert_id} is missing for its delivery`);
  return deliveryTargetSchema.parse(row);
}

/**
 * Settles a claimed delivery. Only the claim that sent it may: an update from a claim whose
 * lease lapsed matches no row.
 *
 * @returns Whether this claim still held the row.
 */
async function settle(
  db: DatabaseExecutor,
  delivery: z.infer<typeof claimedDeliverySchema>,
  claimId: string,
  update: { set: string; values: readonly unknown[] }
): Promise<boolean> {
  const changed = await db.execute(
    `UPDATE admin_alert_deliveries
        SET ${update.set}, claim_id = NULL, updated_at = ?
      WHERE alert_id = ? AND user_id = ? AND claim_id = ? AND status = 'pending'`,
    [...update.values, new Date().toISOString(), delivery.alert_id, delivery.user_id, claimId]
  );
  return changed > 0;
}

type DeliveryOutcome = "sent" | "failed" | "suppressed";

async function deliverOne(
  env: Env,
  db: DatabaseExecutor,
  delivery: z.infer<typeof claimedDeliverySchema>,
  claimId: string,
  context: { clock: () => Date; dashboardOrigin: string }
): Promise<DeliveryOutcome> {
  const target = await deliveryTarget(db, delivery);
  const turnedOff = target.alert_emails === "false" && target.kind !== "alert_emails_changed";
  if (target.admin_email === null || turnedOff) {
    await settle(db, delivery, claimId, {
      set: "status = 'suppressed', claimed_until = NULL",
      values: [],
    });
    return "suppressed";
  }
  try {
    const details = adminAlertDetailsSchema.parse(
      typeof target.details === "string"
        ? parsePostgresJson<unknown>(target.details)
        : target.details
    );
    await sendIterableEmail(env, {
      to: target.admin_email,
      ...adminAlertEmail({
        kind: target.kind,
        details,
        occurredAt: target.occurred_at,
        dashboardOrigin: context.dashboardOrigin,
      }),
    });
  } catch (error) {
    const retryInMs = Math.min(RETRY_BASE_MS * 2 ** (delivery.attempts - 1), RETRY_MAX_MS);
    await settle(db, delivery, claimId, {
      set: "status = 'pending', claimed_until = ?, last_error = ?",
      values: [
        new Date(context.clock().getTime() + retryInMs).toISOString(),
        (error instanceof Error ? error.message : String(error)).slice(0, 500),
      ],
    });
    getLogger().warn(
      {
        event: "sdp_admin_alert_delivery_failed",
        alertId: delivery.alert_id,
        attempts: delivery.attempts,
        error,
      },
      "admin alert email failed; it is retried"
    );
    return "failed";
  }
  const settled = await settle(db, delivery, claimId, {
    set: "status = 'sent', sent_at = ?, claimed_until = NULL, last_error = NULL",
    values: [new Date().toISOString()],
  });
  if (!settled) {
    getLogger().error(
      { event: "sdp_admin_alert_claim_lost", alertId: delivery.alert_id },
      "admin alert email was sent after its claim lapsed; it may be sent again"
    );
  }
  return "sent";
}

/**
 * Abandons what can no longer be sent usefully, then claims and sends due deliveries one at a
 * time, up to a batch. The clock is read at each claim and each failure, not once per run: a
 * slow batch would otherwise hand out leases that have already lapsed and retry deadlines
 * already past.
 *
 * @param clock - The time now; tests pass a fixed or stepping clock.
 * @returns How many were sent, failed (to be retried), suppressed, and abandoned.
 */
export async function deliverAdminAlerts(
  env: Env,
  clock: () => Date = () => new Date()
): Promise<{ sent: number; failed: number; suppressed: number; abandoned: number }> {
  const dashboardOrigin = new URL(dashboardUrlSchema.parse(env.FRONTEND_URL)).origin;
  const db = getDb(env);
  const now = clock();
  const nowIso = now.toISOString();

  const abandoned = await db.execute(
    `UPDATE admin_alert_deliveries
        SET status = 'abandoned', claim_id = NULL, claimed_until = NULL, updated_at = ?
      WHERE status = 'pending'
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

  const outcomes = { sent: 0, failed: 0, suppressed: 0 };
  for (let index = 0; index < ADMIN_ALERT_DELIVERY_BATCH; index += 1) {
    const claimId = crypto.randomUUID();
    const delivery = await claimNext(db, clock(), claimId);
    if (!delivery) break;
    const outcome = await deliverOne(env, db, delivery, claimId, { clock, dashboardOrigin });
    outcomes[outcome] += 1;
  }
  return { ...outcomes, abandoned };
}
