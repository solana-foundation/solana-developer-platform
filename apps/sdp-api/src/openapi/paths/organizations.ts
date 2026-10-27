import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { errorResponseSchema, orgIdParamSchema } from "@/openapi/schemas/base";
import {
  createOrganizationRequestSchema,
  updateOrganizationRequestSchema,
} from "@/openapi/schemas/organizations";
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
      "Creates the caller's organization and makes them its admin, with a Sandbox and a Production project. Called with a signed-in Clerk session that has no active organization. A person creates one organization: repeating the request with the same name finishes or returns it, and another name is refused (409).",
    security: [{ clerkBearerAuth: [] }],
    request: {
      body: { required: true, content: jsonContent(createOrganizationRequestSchema) },
    },
    responses: {
      201: {
        description: "Organization created",
        content: jsonContent(createOrganizationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 409, 429, 500]),
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
    security: [{ clerkBearerAuth: [] }],
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
}
