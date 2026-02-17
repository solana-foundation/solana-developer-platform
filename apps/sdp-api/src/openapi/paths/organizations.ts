import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { z } from "zod";
import {
  createOrganizationRequestSchema,
  errorResponseSchema,
  orgIdParamSchema,
  updateOrganizationRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { createOrganizationResponse, organizationResponse } from "./responses";

export function registerOrganizationPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/organizations",
    tags: ["Organizations"],
    summary: "Create organization",
    operationId: "createOrganization",
    description:
      "Creates an organization and returns an API key summary. Requires x-organization-registration-token. Set returnFullApiKey to true to return the full key once.",
    security: [{ organizationRegistrationToken: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createOrganizationRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Organization created",
        content: jsonContent(createOrganizationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/organizations/{orgId}",
    tags: ["Organizations"],
    summary: "Get organization",
    operationId: "getOrganization",
    description: "Returns organization details for the authenticated organization.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        orgId: orgIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Organization found",
        content: jsonContent(organizationResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/organizations/{orgId}",
    tags: ["Organizations"],
    summary: "Update organization",
    operationId: "updateOrganization",
    description: "Updates organization name or settings.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        orgId: orgIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(updateOrganizationRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Organization updated",
        content: jsonContent(organizationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/organizations/{orgId}",
    tags: ["Organizations"],
    summary: "Delete organization",
    operationId: "deleteOrganization",
    description: "Soft deletes the organization and revokes all API keys.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        orgId: orgIdParamSchema,
      }),
    },
    responses: {
      204: {
        description: "Organization deleted",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

}
