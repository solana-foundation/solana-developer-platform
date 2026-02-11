import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { errorResponseSchema, sessionIdParamSchema } from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { actionSuccessResponse, currentUserResponse, listSessionsResponse } from "./responses";

export function registerAuthPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/auth/logout",
    tags: ["Auth"],
    summary: "Logout session",
    operationId: "logoutSession",
    description: "Revokes the current session and clears the session cookie.",
    security: [{ sessionCookie: [] }],
    responses: {
      200: {
        description: "Logged out",
        content: jsonContent(actionSuccessResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/auth/me",
    tags: ["Auth"],
    summary: "Get current user",
    operationId: "getCurrentUser",
    description: "Returns the current session user, organization, and permissions.",
    security: [{ sessionCookie: [] }],
    responses: {
      200: {
        description: "Current user",
        content: jsonContent(currentUserResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/auth/sessions",
    tags: ["Auth"],
    summary: "List sessions",
    operationId: "listSessions",
    description: "Lists active sessions for the current user.",
    security: [{ sessionCookie: [] }],
    responses: {
      200: {
        description: "Session list",
        content: jsonContent(listSessionsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/auth/sessions/{sessionId}",
    tags: ["Auth"],
    summary: "Revoke session",
    operationId: "revokeSession",
    description: "Revokes an active session by id.",
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({
        sessionId: sessionIdParamSchema,
      }),
    },
    responses: {
      204: {
        description: "Session revoked",
      },
      ...errorResponses(errorResponseSchema, [401, 404, 500]),
    },
  });
}
