import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { errorResponseSchema, pageQuerySchema, pageSizeQuerySchema } from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

// In-app notification endpoints (dashboard bell). Personal scope: rows belong to the
// authenticated (org, user) pair; API-key callers see an empty inbox.
export function registerNotificationPaths(registry: OpenAPIRegistry) {
  const notificationSchema = z
    .object({
      id: z.string().openapi({ example: "notification_abc123" }),
      organization_id: z.string(),
      user_id: z.string(),
      type: z.string().openapi({ example: "workflow_execution" }),
      title: z.string(),
      body: z.string().nullable(),
      resource_type: z.string().nullable().openapi({ example: "token" }),
      resource_id: z.string().nullable(),
      params: z.record(z.string(), z.unknown()).nullable(),
      read_at: z.string().nullable(),
      created_at: z.string(),
    })
    .openapi("Notification");

  const envelope = (inner: z.ZodTypeAny, name: string) =>
    z.object({ data: inner, meta: z.record(z.string(), z.unknown()).optional() }).openapi(name);

  const notificationListResponse = envelope(
    z.object({
      notifications: z.array(notificationSchema),
      total: z.number().int(),
      page: z.number().int(),
      pageSize: z.number().int(),
    }),
    "NotificationListResponse"
  );
  const unreadCountResponse = envelope(
    z.object({ unread: z.number().int() }),
    "NotificationUnreadCountResponse"
  );
  const okResponse = envelope(z.object({ ok: z.boolean() }), "NotificationOkResponse");
  // Exposes ONLY the availability boolean — never provider or configuration details.
  const configResponse = envelope(
    z.object({ emailEnabled: z.boolean() }),
    "NotificationConfigResponse"
  );

  registry.registerPath({
    method: "get",
    path: "/v1/notifications",
    tags: ["Notifications"],
    summary: "List notifications",
    operationId: "listNotifications",
    description:
      "The authenticated user's in-app notifications for the current organization, unread first, newest first.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
        unread: z.enum(["true", "false"]).optional(),
      }),
    },
    responses: {
      200: { description: "Notifications", content: jsonContent(notificationListResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/notifications/unread-count",
    tags: ["Notifications"],
    summary: "Unread notification count",
    operationId: "getUnreadNotificationCount",
    description: "Number of unread notifications for the authenticated user (bell badge).",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders },
    responses: {
      200: { description: "Unread count", content: jsonContent(unreadCountResponse) },
      ...errorResponses(errorResponseSchema, [401, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/notifications/config",
    tags: ["Notifications"],
    summary: "Notification channel availability",
    operationId: "getNotificationConfig",
    description: "Whether the email delivery channel is available (a bare boolean).",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders },
    responses: {
      200: { description: "Channel availability", content: jsonContent(configResponse) },
      ...errorResponses(errorResponseSchema, [401, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/notifications/{id}/read",
    tags: ["Notifications"],
    summary: "Mark a notification read",
    operationId: "markNotificationRead",
    description: "Marks one of the authenticated user's notifications as read (idempotent).",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ id: z.string().openapi({ example: "notification_abc123" }) }),
    },
    responses: {
      200: { description: "Marked read", content: jsonContent(okResponse) },
      ...errorResponses(errorResponseSchema, [401, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/notifications/read-all",
    tags: ["Notifications"],
    summary: "Mark all notifications read",
    operationId: "markAllNotificationsRead",
    description: "Marks all of the authenticated user's notifications as read.",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders },
    responses: {
      200: { description: "All marked read", content: jsonContent(okResponse) },
      ...errorResponses(errorResponseSchema, [401, 500]),
    },
  });
}
