// Per-user notification preferences: the opt-out override rows behind the settings
// matrix. No row = enabled; the effective matrix is composed in the route handler.
// Category/channel vocabulary: @sdp/types NOTIFICATION_CATEGORIES / NOTIFICATION_CHANNELS.

export interface NotificationPreferenceRow {
  organization_id: string;
  user_id: string;
  category: string;
  channel: string;
  enabled: boolean;
  updated_at: string;
}

export interface UpsertNotificationPreferenceEntry {
  category: string;
  channel: string;
  enabled: boolean;
}

export interface NotificationPreferencesRepository {
  listForUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<NotificationPreferenceRow[]>;
  // Full-cell upserts; a PK conflict updates enabled + updated_at.
  upsertMany(params: {
    organizationId: string;
    userId: string;
    entries: UpsertNotificationPreferenceEntry[];
  }): Promise<void>;
  // Dispatcher fast path: which of these users disabled (category, channel). One query
  // regardless of fan-out size; the all-enabled default means absent users pass.
  listDisabledUserIds(params: {
    organizationId: string;
    category: string;
    channel: string;
    userIds: string[];
  }): Promise<Set<string>>;
}
