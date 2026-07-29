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
    read_at: (row.read_at as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

export function createPostgresNotificationsRepository(db: AppDb): NotificationsRepository {
  return {
    async create(input: CreateNotificationInput) {
      const id = generateNotificationId();
      const inserted = await db
        .prepare(
          `INSERT INTO notifications (
             id, organization_id, user_id, type, title, body, resource_type, resource_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.userId,
          input.type,
          input.title,
          input.body ?? null,
          input.resourceType ?? null,
          input.resourceId ?? null
        )
        .first<Record<string, unknown>>();
      return inserted ? mapRow(inserted) : null;
    },

    async listForUser(params: ListNotificationsInput) {
      const filters = ["organization_id = ?", "user_id = ?"];
      const bindings: Array<string | number> = [params.organizationId, params.userId];
      if (params.unreadOnly) {
        filters.push("read_at IS NULL");
      }
      const where = filters.join(" AND ");

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

    async markRead(params) {
      await db
        .prepare(
          `UPDATE notifications SET read_at = sdp_iso_now()
             WHERE id = ? AND organization_id = ? AND user_id = ? AND read_at IS NULL`
        )
        .bind(params.notificationId, params.organizationId, params.userId)
        .run();
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
