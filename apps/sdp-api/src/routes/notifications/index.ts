/**
 * In-app notification routes (dashboard bell). Personal, per-user — no project scope.
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import type { Env } from "@/types/env";
import {
  getNotificationConfig,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./handlers";

const notifications = new Hono<{ Bindings: Env }>();

notifications.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

notifications.get("/", requirePermissions("org:read"), listNotifications);
notifications.get("/unread-count", requirePermissions("org:read"), getUnreadCount);
notifications.get("/config", requirePermissions("org:read"), getNotificationConfig);
notifications.post("/read-all", requirePermissions("org:read"), markAllNotificationsRead);
notifications.post("/:id/read", requirePermissions("org:read"), markNotificationRead);

export default notifications;
