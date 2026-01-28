import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { z } from "zod";
import {
  acceptInvitationRequestSchema,
  createOrganizationRequestSchema,
  errorResponseSchema,
  inviteMemberRequestSchema,
  orgIdParamSchema,
  updateOrganizationRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import {
  actionSuccessResponse,
  createOrganizationResponse,
  inviteMemberResponse,
  listMembersResponse,
  organizationResponse,
} from "./responses";

export function registerOrganizationPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/organizations",
    tags: ["Organizations"],
    summary: "Create organization",
    operationId: "createOrganization",
    description:
      "Creates an organization and returns a sandbox API key. The full key is returned once.",
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

  registry.registerPath({
    method: "get",
    path: "/v1/organizations/{orgId}/members",
    tags: ["Members"],
    summary: "List organization members",
    operationId: "listOrganizationMembers",
    description: "Lists members in the organization.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        orgId: orgIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Members retrieved",
        content: jsonContent(listMembersResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/organizations/{orgId}/members",
    tags: ["Members"],
    summary: "Invite organization member",
    operationId: "inviteOrganizationMember",
    description: "Invites a new member to the organization.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        orgId: orgIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(inviteMemberRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Invitation created",
        content: jsonContent(inviteMemberResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/organizations/{orgId}/members/accept",
    tags: ["Members"],
    summary: "Accept invitation",
    operationId: "acceptOrganizationInvitation",
    description: "Accepts an organization member invitation.",
    request: {
      params: z.object({
        orgId: orgIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(acceptInvitationRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Invitation accepted",
        content: jsonContent(actionSuccessResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 404, 409, 500]),
    },
  });
}
