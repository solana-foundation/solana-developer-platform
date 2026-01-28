import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  addAdminAllowlistEntryRequestSchema,
  allowlistEntryIdParamSchema,
  allowlistStatusQuerySchema,
  allowlistTypeQuerySchema,
  errorResponseSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { allowlistEntriesResponse, allowlistEntryResponse } from "./responses";

export function registerAdminPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/admin/allowlist",
    tags: ["Admin"],
    summary: "List allowlist entries",
    operationId: "listAllowlistEntries",
    description: "Lists allowlist entries for onboarding.",
    security: [{ adminKey: [] }],
    request: {
      query: z.object({
        type: allowlistTypeQuerySchema.optional(),
        status: allowlistStatusQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Allowlist entries",
        content: jsonContent(allowlistEntriesResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/admin/allowlist",
    tags: ["Admin"],
    summary: "Add allowlist entry",
    operationId: "addAllowlistEntry",
    description: "Adds an allowlist entry for onboarding.",
    security: [{ adminKey: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(addAdminAllowlistEntryRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Allowlist entry created",
        content: jsonContent(allowlistEntryResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 409, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/admin/allowlist/{id}",
    tags: ["Admin"],
    summary: "Remove allowlist entry",
    operationId: "removeAllowlistEntry",
    description: "Removes (disables) an allowlist entry.",
    security: [{ adminKey: [] }],
    request: {
      params: z.object({
        id: allowlistEntryIdParamSchema,
      }),
    },
    responses: {
      204: {
        description: "Allowlist entry removed",
      },
      ...errorResponses(errorResponseSchema, [401, 404, 500]),
    },
  });
}
