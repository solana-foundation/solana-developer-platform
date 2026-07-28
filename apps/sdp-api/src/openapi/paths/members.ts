import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  acceptInvitationRequestSchema,
  errorResponseSchema,
  invitationIdSchema,
  inviteMemberRequestSchema,
  listMembersQuerySchema,
  memberIdParamSchema,
} from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";
import { actionSuccessResponse, inviteMemberResponse, listMembersResponse } from "./responses";

export function registerMemberPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/members",
    tags: ["Members"],
    summary: "List organization members",
    operationId: "listMembers",
    description:
      "Lists members of the authenticated organization, followed by any pending invitations the caller is permitted to see. The two page as one sequence. Invitations require `org:write`, because each carries a shareable acceptance link.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: listMembersQuerySchema,
    },
    responses: {
      200: {
        description: "Members list",
        content: jsonContent(listMembersResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/members/invite",
    tags: ["Members"],
    summary: "Invite member",
    operationId: "inviteMember",
    description: "Creates an invitation for a new organization member.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
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
    path: "/v1/members/accept",
    tags: ["Members"],
    summary: "Accept invitation",
    operationId: "acceptInvitation",
    description: "Accepts an invitation token and activates membership.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/members/invitations/{invitationId}",
    tags: ["Members"],
    summary: "Revoke invitation",
    operationId: "revokeInvitation",
    description:
      "Withdraws a pending invitation, in Clerk as well as locally. Only a pending invitation can be revoked.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        invitationId: invitationIdSchema,
      }),
    },
    responses: {
      204: {
        description: "Invitation revoked",
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/members/{memberId}",
    tags: ["Members"],
    summary: "Remove member",
    operationId: "removeMember",
    description: "Removes a member from the organization.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        memberId: memberIdParamSchema,
      }),
    },
    responses: {
      204: {
        description: "Member removed",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });
}
