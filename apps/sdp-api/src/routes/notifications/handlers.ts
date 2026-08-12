import type { Context } from "hono";
import { createNotificationsRepository } from "@/db/repositories";
import { notFound } from "@/lib/errors";
import { parsePagination } from "@/lib/query";
import { success } from "@/lib/response";
import { isEmailConfigured } from "@/services/email";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

// Notifications are personal — scoped to (org, user). API-key auth has no user, so it
// resolves to null and those callers simply see an empty inbox.
function resolveUser(c: AppContext): { organizationId: string; userId: string } | null {
  const clerk = c.get("clerk");
  if (clerk?.userId && clerk.organizationId) {
    return { organizationId: clerk.organizationId, userId: clerk.userId };
  }
  const session = c.get("session");
  if (session?.userId && session.organizationId) {
    return { organizationId: session.organizationId, userId: session.userId };
  }
  return null;
}

export const listNotifications = async (c: AppContext) => {
  const user = resolveUser(c);
  if (!user) {
    return success(c, { notifications: [], total: 0, page: 1, pageSize: 20 });
  }

  const { page, pageSize, offset } = parsePagination(
    { page: c.req.query("page"), pageSize: c.req.query("pageSize") },
    { pageSize: 20, maxPageSize: 100 }
  );
  const unreadOnly = c.req.query("unread") === "true";

  const { rows, total } = await createNotificationsRepository(c.env).listForUser({
    organizationId: user.organizationId,
    userId: user.userId,
    unreadOnly,
    limit: pageSize,
    offset,
  });

  return success(c, { notifications: rows, total, page, pageSize });
};

export const getUnreadCount = async (c: AppContext) => {
  const user = resolveUser(c);
  if (!user) {
    return success(c, { unread: 0 });
  }
  const unread = await createNotificationsRepository(c.env).countUnread({
    organizationId: user.organizationId,
    userId: user.userId,
  });
  return success(c, { unread });
};

export const markNotificationRead = async (c: AppContext) => {
  const user = resolveUser(c);
  const notificationId = c.req.param("id");
  if (!user || !notificationId) {
    return success(c, { ok: true });
  }
  const found = await createNotificationsRepository(c.env).markRead({
    notificationId,
    organizationId: user.organizationId,
    userId: user.userId,
  });
  if (!found) {
    throw notFound("Notification not found");
  }
  return success(c, { ok: true });
};

export const markAllNotificationsRead = async (c: AppContext) => {
  const user = resolveUser(c);
  if (!user) {
    return success(c, { ok: true });
  }
  await createNotificationsRepository(c.env).markAllRead({
    organizationId: user.organizationId,
    userId: user.userId,
  });
  return success(c, { ok: true });
};

// Whether the email channel is available. Exposes ONLY the boolean — never the provider
// name or env-var names — so the UI can show a generic "email unavailable" badge.
export const getNotificationConfig = async (c: AppContext) => {
  return success(c, { emailEnabled: isEmailConfigured(c.env) });
};
