import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  type NotificationPreferenceDto,
} from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import {
  createNotificationPreferencesRepository,
  createNotificationsRepository,
} from "@/db/repositories";
import { badRequest, notFound } from "@/lib/errors";
import { parsePagination } from "@/lib/query";
import { success } from "@/lib/response";
import { isEmailConfigured } from "@/services/email";
import type { Env } from "@/types/env";
import { updatePreferencesSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

// Notifications are personal — scoped to (org, user). API-key auth has no user, so it
// resolves to null and those callers simply see an empty inbox.
export function resolveUser(c: AppContext): { organizationId: string; userId: string } | null {
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

// The all-enabled default matrix: preferences are opt-out, so absent rows read as on.
function defaultPreferenceMatrix(): NotificationPreferenceDto[] {
  return NOTIFICATION_CATEGORIES.flatMap((category) =>
    NOTIFICATION_CHANNELS.map((channel) => ({ category, channel, enabled: true }))
  );
}

async function effectivePreferences(
  c: AppContext,
  user: { organizationId: string; userId: string }
): Promise<NotificationPreferenceDto[]> {
  const overrides = await createNotificationPreferencesRepository(c.env).listForUser(user);
  const overrideByCell = new Map(
    overrides.map((row) => [`${row.category}:${row.channel}`, row.enabled])
  );
  return defaultPreferenceMatrix().map((cell) => ({
    ...cell,
    enabled: overrideByCell.get(`${cell.category}:${cell.channel}`) ?? cell.enabled,
  }));
}

export const getNotificationPreferences = async (c: AppContext) => {
  const user = resolveUser(c);
  const emailEnabled = isEmailConfigured(c.env);
  if (!user) {
    // API-key auth has no personal inbox; show the defaults, matching the router's
    // empty-200 convention.
    return success(c, { preferences: defaultPreferenceMatrix(), emailEnabled });
  }
  return success(c, { preferences: await effectivePreferences(c, user), emailEnabled });
};

export const updateNotificationPreferences = async (c: AppContext) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }
  const parsed = updatePreferencesSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const user = resolveUser(c);
  const emailEnabled = isEmailConfigured(c.env);
  if (!user) {
    // No personal identity to write against — validate, no-op, return the defaults.
    return success(c, { preferences: defaultPreferenceMatrix(), emailEnabled });
  }

  await createNotificationPreferencesRepository(c.env).upsertMany({
    organizationId: user.organizationId,
    userId: user.userId,
    entries: parsed.data.preferences,
  });
  return success(c, { preferences: await effectivePreferences(c, user), emailEnabled });
};
