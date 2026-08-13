import type { AppDb } from "@/db";
import {
  type ClaimNotificationDeliveryInput,
  generateNotificationDeliveryId,
  type NotificationDeliveriesRepository,
} from "./notification-delivery.repository";

export function createPostgresNotificationDeliveriesRepository(
  db: AppDb
): NotificationDeliveriesRepository {
  return {
    async claim(input: ClaimNotificationDeliveryInput) {
      // Single-statement claim: a fresh key inserts; a 'failed' key is taken over
      // (recipient may have changed, e.g. a corrected counterparty email); 'sent' and
      // in-flight 'pending' rows match the conflict but fail the WHERE, returning
      // nothing — the caller skips the send.
      const row = await db
        .prepare(
          `INSERT INTO notification_deliveries
             (id, organization_id, user_id, channel, recipient, dedupe_key)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (channel, dedupe_key) DO UPDATE
             SET status = 'pending',
                 recipient = EXCLUDED.recipient,
                 attempt_count = notification_deliveries.attempt_count + 1,
                 error = NULL,
                 updated_at = sdp_iso_now()
             WHERE notification_deliveries.status = 'failed'
           RETURNING id`
        )
        .bind(
          generateNotificationDeliveryId(),
          input.organizationId,
          input.userId,
          input.channel,
          input.recipient,
          input.dedupeKey
        )
        .first<{ id: string }>();
      return row?.id ?? null;
    },

    async claimMany(inputs: ClaimNotificationDeliveryInput[]) {
      if (inputs.length === 0) {
        return new Map<string, string>();
      }
      // The single-claim statement, multi-row: same conflict semantics per row, one
      // round-trip for the whole fan-out instead of one per recipient.
      const placeholders = inputs.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const bindings = inputs.flatMap((input) => [
        generateNotificationDeliveryId(),
        input.organizationId,
        input.userId,
        input.channel,
        input.recipient,
        input.dedupeKey,
      ]);
      const rows = await db
        .prepare(
          `INSERT INTO notification_deliveries
             (id, organization_id, user_id, channel, recipient, dedupe_key)
           VALUES ${placeholders}
           ON CONFLICT (channel, dedupe_key) DO UPDATE
             SET status = 'pending',
                 recipient = EXCLUDED.recipient,
                 attempt_count = notification_deliveries.attempt_count + 1,
                 error = NULL,
                 updated_at = sdp_iso_now()
             WHERE notification_deliveries.status = 'failed'
           RETURNING id, dedupe_key`
        )
        .bind(...bindings)
        .all<{ id: string; dedupe_key: string }>();
      return new Map(rows.results.map((row) => [row.dedupe_key, row.id]));
    },

    async markSent(params) {
      await db
        .prepare(
          `UPDATE notification_deliveries
             SET status = 'sent', provider_message_id = ?, updated_at = sdp_iso_now()
             WHERE id = ?`
        )
        .bind(params.providerMessageId, params.id)
        .run();
    },

    async markFailed(params) {
      await db
        .prepare(
          `UPDATE notification_deliveries
             SET status = 'failed', error = ?, updated_at = sdp_iso_now()
             WHERE id = ?`
        )
        .bind(params.error, params.id)
        .run();
    },
  };
}
