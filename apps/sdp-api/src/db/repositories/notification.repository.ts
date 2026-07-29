import type { RepositoryDbClient } from "./base";

export function generateNotificationId(): string {
  return `notification_${crypto.randomUUID()}`;
}

export interface NotificationRow {
  id: string;
  organization_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface CreateNotificationInput {
  organizationId: string;
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

export interface ListNotificationsInput {
  organizationId: string;
  userId: string;
  unreadOnly: boolean;
  limit: number;
  offset: number;
}

export interface NotificationsRepositoryContext {
  db: RepositoryDbClient;
}

export interface NotificationsRepository {
  create(input: CreateNotificationInput): Promise<NotificationRow | null>;
  listForUser(params: ListNotificationsInput): Promise<{ rows: NotificationRow[]; total: number }>;
  countUnread(params: { organizationId: string; userId: string }): Promise<number>;
  // Mark one notification read; scoped to (org, user) so a user can only touch their own.
  markRead(params: {
    notificationId: string;
    organizationId: string;
    userId: string;
  }): Promise<void>;
  markAllRead(params: { organizationId: string; userId: string }): Promise<void>;
}
