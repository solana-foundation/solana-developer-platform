import { z } from "zod";
import { getDb } from "@/db/client";
import { getLogger } from "@/runtime/logger";
import {
  ACCOUNT_PII_RETENTION_DAYS,
  ACCOUNT_PII_RETENTION_ENFORCED,
} from "@/services/data-retention-policy";
import type { Env } from "@/types/env";

const RETENTION_BATCH_SIZE = 1000;
const RETENTION_MAX_BATCHES = 20;
const RETENTION_MAX_ROWS = RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES;
const countsSchema = z.object({
  invitations: z.number(),
  alerts: z.number(),
  deliveries: z.number(),
});

/** Report proposed retention candidates; enforce only after policy approval. */
export async function pruneAccountPii(env: Env, now: Date = new Date()) {
  const db = getDb(env);
  const cutoff = new Date(now.getTime() - ACCOUNT_PII_RETENTION_DAYS * 86_400_000).toISOString();
  // Legacy invitations use both SQL and ISO UTC timestamps. This coarse,
  // indexed expiry bound includes the cutoff day; the timestamp check below
  // still decides eligibility using creation, expiry, and acceptance together.
  const invitationBefore = new Date(Date.parse(cutoff) + 86_400_000).toISOString().slice(0, 10);
  if (!ACCOUNT_PII_RETENTION_ENFORCED) {
    const counts = countsSchema.parse(
      await db.queryOne(
        `SELECT
         (SELECT COUNT(*)::int FROM (
           SELECT 1 FROM invitations WHERE pii_pseudonymized_at IS NULL
             AND email NOT LIKE '%@users.invalid' AND expires_at < ?
             AND GREATEST(expires_at::timestamptz, created_at::timestamptz, accepted_at::timestamptz)
                 <= ?::timestamptz
           LIMIT ?
         ) candidates) AS invitations,
         (SELECT COUNT(*)::int FROM (
           SELECT 1 FROM admin_alerts WHERE created_at <= ?
             AND (details->>'actor' IS NOT NULL OR details->>'subject' IS NOT NULL)
           LIMIT ?
         ) candidates) AS alerts,
         (SELECT COUNT(*)::int FROM (
           SELECT 1 FROM admin_alert_deliveries WHERE created_at <= ?
             AND email NOT LIKE '%@deleted.invalid'
           LIMIT ?
         ) candidates) AS deliveries`,
        [
          invitationBefore,
          cutoff,
          RETENTION_MAX_ROWS,
          cutoff,
          RETENTION_MAX_ROWS,
          cutoff,
          RETENTION_MAX_ROWS,
        ]
      )
    );
    const capped = Object.values(counts).some((count) => count === RETENTION_MAX_ROWS);
    getLogger().info(
      { event: "sdp_account_pii_pruned", mode: "dry-run", ...counts, capped },
      "proposed account PII retention candidates"
    );
    return { ...counts, mode: "dry-run", capped };
  }

  const counts = {
    invitations: 0,
    alerts: 0,
    deliveries: 0,
    mode: "enforce",
    capped: false,
  };
  for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
    const changed = await db.transaction(async (tx) => {
      const invitations = await tx.execute(
        `UPDATE invitations SET
           email = encode(sha256(convert_to(id, 'UTF8')), 'hex') || '@deleted.invalid',
           status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
           pii_pseudonymized_at = sdp_iso_now()
         WHERE id IN (
           SELECT id FROM invitations WHERE pii_pseudonymized_at IS NULL
             AND email NOT LIKE '%@users.invalid' AND expires_at < ?
             AND GREATEST(expires_at::timestamptz, created_at::timestamptz,
                          accepted_at::timestamptz) <= ?::timestamptz
           ORDER BY expires_at, id LIMIT ? FOR UPDATE SKIP LOCKED
         )`,
        [invitationBefore, cutoff, RETENTION_BATCH_SIZE]
      );
      const alerts = await tx.execute(
        `UPDATE admin_alerts SET details = details || '{"actor":null,"subject":null}'::jsonb
          WHERE id IN (
            SELECT id FROM admin_alerts WHERE created_at <= ?
              AND (details->>'actor' IS NOT NULL OR details->>'subject' IS NOT NULL)
            ORDER BY created_at, id LIMIT ? FOR UPDATE SKIP LOCKED
          )`,
        [cutoff, RETENTION_BATCH_SIZE]
      );
      const deliveries = await tx.execute(
        `UPDATE admin_alert_deliveries SET
           email = encode(sha256(convert_to(user_id, 'UTF8')), 'hex') || '@deleted.invalid',
           status = CASE WHEN status = 'pending' THEN 'suppressed' ELSE status END,
           claim_id = NULL, claimed_until = NULL, last_error = NULL, updated_at = sdp_iso_now()
         WHERE (alert_id, user_id) IN (
           SELECT alert_id, user_id FROM admin_alert_deliveries
            WHERE created_at <= ?
              AND email NOT LIKE '%@deleted.invalid'
            ORDER BY created_at, alert_id, user_id LIMIT ? FOR UPDATE SKIP LOCKED
         )`,
        [cutoff, RETENTION_BATCH_SIZE]
      );
      return { invitations, alerts, deliveries };
    });
    for (const key of ["invitations", "alerts", "deliveries"] as const) {
      counts[key] += changed[key];
    }
    counts.capped = Object.values(changed).some((count) => count === RETENTION_BATCH_SIZE);
    if (!counts.capped) break;
  }
  getLogger().info(
    { event: "sdp_account_pii_pruned", ...counts },
    "account PII retention completed"
  );
  return counts;
}
