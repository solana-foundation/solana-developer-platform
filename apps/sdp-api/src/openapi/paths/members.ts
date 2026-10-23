import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  errorResponseSchema,
  invitationIdSchema,
  memberIdParamSchema,
} from "@/openapi/schemas/base";
import {
  inviteMemberRequestSchema,
  listMembersQuerySchema,
  updateMemberRoleRequestSchema,
} from "@/openapi/schemas/organizations";
import { errorResponses, jsonContent, projectScopeWithDeclaredIdempotencyHeaders } from "./helpers";
import { inviteMemberResponse, listMembersResponse, memberRoleResponse } from "./responses";

// Matches each route's `idempotent()` step (ADR 0009); spec.test.ts checks.
const keyAcceptedStoredHeaders = projectScopeWithDeclaredIdempotencyHeaders({
  key: "accepted",
  serverErrors: "store",
});
const keyAcceptedRerunHeaders = projectScopeWithDeclaredIdempotencyHeaders({
  key: "accepted",
  serverErrors: "rerun",
});

export function registerMemberPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/members",
    tags: ["Members"],
    summary: "List organization members",
    operationId: "listMembers",
    description:
      "Lists members of the authenticated organization, followed by any pending invitations the caller is permitted to see. The two page as one sequence. Invitations require `members.manage`, because each names an invitee's email address. Clerk's acceptance link is never returned: it reaches only the invitee's inbox.",
    security: [{ clerkBearerAuth: [] }],
    request: {
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
    method: "get",
    path: "/v1/members/me",
    tags: ["Members"],
    summary: "Get current member",
    operationId: "getCurrentMember",
    description:
      "Returns the caller's own membership in the authenticated organization. The role is SDP's, never Clerk's, and is what every permission check uses.",
    security: [{ clerkBearerAuth: [] }],
    responses: {
      200: {
        description: "Current member",
        content: jsonContent(memberRoleResponse),
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
    description:
      "Invites an address to the organization at the given role. The invitation, and Clerk's emailed link, expire after 7 days. An address can hold one pending invitation per organization: a second one is refused (409) before any email is sent.",
    security: [{ clerkBearerAuth: [] }],
    request: {
      headers: keyAcceptedStoredHeaders,
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
    method: "delete",
    path: "/v1/members/invitations/{invitationId}",
    tags: ["Members"],
    summary: "Revoke invitation",
    operationId: "revokeInvitation",
    description:
      "Withdraws a pending invitation, in SDP and then in Clerk. An accepted or expired invitation cannot be revoked (400). Revoking an invitation already revoked withdraws whatever is still pending in Clerk, so a retry after a failed Clerk call completes the revocation.",
    security: [{ clerkBearerAuth: [] }],
    request: {
      headers: keyAcceptedRerunHeaders,
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
    path: "/v1/members/me",
    tags: ["Members"],
    summary: "Leave organization",
    operationId: "leaveOrganization",
    description:
      "Ends the caller's own membership, their project memberships in the organization and their pending invitations to it. An admin cannot leave (409); another admin removes them instead.",
    security: [{ clerkBearerAuth: [] }],
    responses: {
      204: {
        description: "Left the organization",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/members/{memberId}",
    tags: ["Members"],
    summary: "Change member role",
    operationId: "updateMemberRole",
    description:
      "Changes another member's Organization Role. An admin cannot change their own role, and the last active admin cannot be demoted (409). Takes effect on the member's next request.",
    security: [{ clerkBearerAuth: [] }],
    request: {
      headers: keyAcceptedStoredHeaders,
      params: z.object({
        memberId: memberIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(updateMemberRoleRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Member role",
        content: jsonContent(memberRoleResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/members/{memberId}",
    tags: ["Members"],
    summary: "Remove member",
    operationId: "removeMember",
    description:
      "Removes another member from the organization, along with their project memberships in it and their pending invitations, so an unspent invitation cannot readmit them. The last active admin cannot be removed, and nobody can remove themselves (409). Removing a member already removed withdraws their Clerk membership again and changes nothing else, so a retry after a failed Clerk call completes the removal. Re-inviting the removed member issues a fresh invitation that works normally.",
    security: [{ clerkBearerAuth: [] }],
    request: {
      headers: keyAcceptedRerunHeaders,
      params: z.object({
        memberId: memberIdParamSchema,
      }),
    },
    responses: {
      204: {
        description: "Member removed",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 409, 500]),
    },
  });
}
