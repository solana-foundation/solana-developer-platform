import type { AppDb } from "@/db";
import {
  type CreateNotificationInput,
  generateNotificationId,
  type ListNotificationsInput,
  type NotificationRow,
  type NotificationsRepository,
} from "./notification.repository";

function mapRow(row: Record<string, unknown>): NotificationRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    user_id: row.user_id as string,
    type: row.type as string,
    title: row.title as string,
    body: (row.body as string | null) ?? null,
    resource_type: (row.resource_type as string | null) ?? null,
    resource_id: (row.resource_id as string | null) ?? null,
    params: (row.params as Record<string, unknown> | null) ?? null,
    read_at: (row.read_at as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

const INSERT_COLUMNS =
  "id, organization_id, user_id, type, title, body, resource_type, resource_id, params, dedupe_key";
const ROW_PLACEHOLDER = "(?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)";
// Retried producers no-op on the (user_id, dedupe_key) partial unique index.
const ON_CONFLICT = "ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING";

function bindRow(input: CreateNotificationInput): Array<string | null> {
  return [
    generateNotificationId(),
    input.organizationId,
    input.userId,
    input.type,
    input.title,
    input.body ?? null,
    input.resourceType ?? null,
    input.resourceId ?? null,
    input.params ? JSON.stringify(input.params) : null,
    input.dedupeKey ?? null,
  ];
}

// Bound multi-row insert batch (10 bindings per row).
const INSERT_BATCH_SIZE = 100;

export function createPostgresNotificationsRepository(db: AppDb): NotificationsRepository {
  return {
    async create(input: CreateNotificationInput) {
      const inserted = await db
        .prepare(
          `INSERT INTO notifications (${INSERT_COLUMNS})
           VALUES ${ROW_PLACEHOLDER}
           ${ON_CONFLICT}
           RETURNING *`
        )
        .bind(...bindRow(input))
        .first<Record<string, unknown>>();
      return inserted ? mapRow(inserted) : null;
    },

    async createMany(inputs: CreateNotificationInput[]) {
      let inserted = 0;
      for (let offset = 0; offset < inputs.length; offset += INSERT_BATCH_SIZE) {
        const batch = inputs.slice(offset, offset + INSERT_BATCH_SIZE);
        const placeholders = batch.map(() => ROW_PLACEHOLDER).join(", ");
        inserted += await db
          .prepare(
            `INSERT INTO notifications (${INSERT_COLUMNS})
             VALUES ${placeholders}
             ${ON_CONFLICT}`
          )
          .bind(...batch.flatMap(bindRow))
          .run();
      }
      return inserted;
    },

    async listForUser(params: ListNotificationsInput) {
      const filters = ["organization_id = ?", "user_id = ?"];
      const bindings: Array<string | number> = [params.organizationId, params.userId];
      if (params.unreadOnly) {
        filters.push("read_at IS NULL");
      }
      const where = filters.join(" AND ");

      // Strictly newest-first. Deliberately NOT unread-first: mark-read must not
      // re-sort the list, because the bell pages by offset — a leading read-state sort
      // key shifted rows between pages as the user read them, silently skipping
      // notifications. Chronological order is also served by idx_notifications_user
      // ((org, user, created_at DESC)); the partition sort was a full re-sort before.
      const rowsResult = await db
        .prepare(
          `SELECT * FROM notifications WHERE ${where}
             ORDER BY created_at DESC LIMIT ? OFFSET ?`
        )
        .bind(...bindings, params.limit, params.offset)
        .all<Record<string, unknown>>();

      const totalRow = await db
        .prepare(`SELECT COUNT(*)::int AS total FROM notifications WHERE ${where}`)
        .bind(...bindings)
        .first<{ total: number }>();

      return { rows: rowsResult.results.map(mapRow), total: totalRow?.total ?? 0 };
    },

    async countUnread(params) {
      const row = await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM notifications
             WHERE organization_id = ? AND user_id = ? AND read_at IS NULL`
        )
        .bind(params.organizationId, params.userId)
        .first<{ total: number }>();
      return row?.total ?? 0;
    },

    async countUnreadForUsers(params) {
      const counts = new Map<string, number>(params.userIds.map((userId) => [userId, 0]));
      if (params.userIds.length === 0) {
        return counts;
      }
      const result = await db
        .prepare(
          `SELECT user_id, COUNT(*)::int AS total FROM notifications
             WHERE organization_id = ? AND user_id = ANY(?::text[]) AND read_at IS NULL
             GROUP BY user_id`
        )
        .bind(params.organizationId, params.userIds)
        .all<{ user_id: string; total: number }>();
      for (const row of result.results) {
        counts.set(row.user_id, row.total);
      }
      return counts;
    },

    async markRead(params) {
      // Idempotent: re-marking an already-read row still matches (and keeps its
      // original read_at); a nonexistent/foreign id matches nothing → false.
      const rowsAffected = await db
        .prepare(
          `UPDATE notifications SET read_at = COALESCE(read_at, sdp_iso_now())
             WHERE id = ? AND organization_id = ? AND user_id = ?`
        )
        .bind(params.notificationId, params.organizationId, params.userId)
        .run();
      return rowsAffected > 0;
    },

    async markAllRead(params) {
      await db
        .prepare(
          `UPDATE notifications SET read_at = sdp_iso_now()
             WHERE organization_id = ? AND user_id = ? AND read_at IS NULL`
        )
        .bind(params.organizationId, params.userId)
        .run();
    },
  };
}
