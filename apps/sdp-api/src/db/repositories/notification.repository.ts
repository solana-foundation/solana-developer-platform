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
  // Structured facts for client-side (localized) rendering; title/body are the fallback.
  params: Record<string, unknown> | null;
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
  params?: Record<string, unknown> | null;
  // Producer idempotency handle (e.g. workflow execution id): a retried producer
  // no-ops instead of duplicating the user's notification.
  dedupeKey?: string | null;
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
  // Returns null when the (user, dedupeKey) pair already exists (idempotent re-delivery).
  create(input: CreateNotificationInput): Promise<NotificationRow | null>;
  // Multi-row fan-out in one round trip; duplicate (user, dedupeKey) rows are skipped.
  // Returns the number of rows actually inserted.
  createMany(inputs: CreateNotificationInput[]): Promise<number>;
  listForUser(params: ListNotificationsInput): Promise<{ rows: NotificationRow[]; total: number }>;
  countUnread(params: { organizationId: string; userId: string }): Promise<number>;
  // Mark one notification read; scoped to (org, user) so a user can only touch their
  // own. Returns false when no matching row exists.
  markRead(params: {
    notificationId: string;
    organizationId: string;
    userId: string;
  }): Promise<boolean>;
  markAllRead(params: { organizationId: string; userId: string }): Promise<void>;
}
