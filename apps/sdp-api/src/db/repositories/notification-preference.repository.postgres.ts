import type { AppDb } from "@/db";
import type {
  NotificationPreferenceRow,
  NotificationPreferencesRepository,
  UpsertNotificationPreferenceEntry,
} from "./notification-preference.repository";

function mapRow(row: Record<string, unknown>): NotificationPreferenceRow {
  return {
    organization_id: row.organization_id as string,
    user_id: row.user_id as string,
    category: row.category as string,
    channel: row.channel as string,
    enabled: Boolean(row.enabled),
    updated_at: row.updated_at as string,
  };
}

export function createPostgresNotificationPreferencesRepository(
  db: AppDb
): NotificationPreferencesRepository {
  return {
    async listForUser(params) {
      const result = await db
        .prepare(
          `SELECT * FROM notification_preferences
             WHERE organization_id = ? AND user_id = ?`
        )
        .bind(params.organizationId, params.userId)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async upsertMany(params) {
      if (params.entries.length === 0) {
        return;
      }
      const placeholders = params.entries.map(() => "(?, ?, ?, ?, ?)").join(", ");
      const bindings = params.entries.flatMap((entry: UpsertNotificationPreferenceEntry) => [
        params.organizationId,
        params.userId,
        entry.category,
        entry.channel,
        entry.enabled,
      ]);
      await db
        .prepare(
          `INSERT INTO notification_preferences
             (organization_id, user_id, category, channel, enabled)
           VALUES ${placeholders}
           ON CONFLICT (organization_id, user_id, category, channel)
           DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = sdp_iso_now()`
        )
        .bind(...bindings)
        .run();
    },

    async listDisabledUserIds(params) {
      if (params.userIds.length === 0) {
        return new Set();
      }
      const result = await db
        .prepare(
          `SELECT user_id FROM notification_preferences
             WHERE organization_id = ? AND category = ? AND channel = ?
               AND enabled = FALSE AND user_id = ANY(?::text[])`
        )
        .bind(params.organizationId, params.category, params.channel, params.userIds)
        .all<{ user_id: string }>();
      return new Set(result.results.map((row) => row.user_id));
    },
  };
}
