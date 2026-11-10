import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { errorResponseSchema, orgIdParamSchema } from "@/openapi/schemas/base";
import {
  createOrganizationRequestSchema,
  requestMainnetAccessRequestSchema,
  sendFeedbackRequestSchema,
  updateOrganizationRequestSchema,
} from "@/openapi/schemas/organizations";
import { errorResponses, jsonContent } from "./helpers";
import {
  createOrganizationResponse,
  mainnetAccessResponse,
  organizationResponse,
  sendFeedbackResponse,
} from "./responses";

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

  registry.registerPath({
    method: "get",
    path: "/v1/organizations/{orgId}/mainnet-access",
    tags: ["Organizations"],
    summary: "Get mainnet access",
    operationId: "getMainnetAccess",
    description:
      "Returns where the organization's mainnet access stands, with its declared jurisdiction and Terms and Conditions acceptance, and whether this deployment takes requests. A signed-in admin only, never an API key.",
    security: [{ clerkBearerAuth: [] }],
    request: { params: z.object({ orgId: orgIdParamSchema }) },
    responses: {
      200: { description: "Mainnet access", content: jsonContent(mainnetAccessResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/organizations/{orgId}/mainnet-access",
    tags: ["Organizations"],
    summary: "Request mainnet access",
    operationId: "requestMainnetAccess",
    description:
      "Records the organization's jurisdiction and its acceptance of the current SDP Terms and Conditions, and asks SDP to enable mainnet. Once per organization; an operator approves it. A signed-in admin only, never an API key. Refused with 409 once the organization asked, when mainnet is already enabled, or when the terms version is not the current one. If the email to SDP fails, the request stays recorded and `POST …/notify` sends it.",
    security: [{ clerkBearerAuth: [] }],
    request: {
      params: z.object({ orgId: orgIdParamSchema }),
      body: { required: true, content: jsonContent(requestMainnetAccessRequestSchema) },
    },
    responses: {
      201: { description: "Request sent", content: jsonContent(mainnetAccessResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/organizations/{orgId}/mainnet-access/notify",
    tags: ["Organizations"],
    summary: "Send a mainnet access request again",
    operationId: "notifyMainnetAccess",
    description:
      "Sends the organization's recorded request to SDP when its email did not go out. Changes nothing else. A signed-in admin only, never an API key. Refused with 409 when the organization has not asked or its request was already sent.",
    security: [{ clerkBearerAuth: [] }],
    request: { params: z.object({ orgId: orgIdParamSchema }) },
    responses: {
      200: { description: "Request sent", content: jsonContent(mainnetAccessResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 409, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/organizations/{orgId}/feedback",
    tags: ["Organizations"],
    summary: "Send feedback",
    operationId: "sendFeedback",
    description:
      "Emails feedback from the dashboard to the SDP team, replying to the sender's email. Nothing is stored. A signed-in person in any role, never an API key. Refused with 503 when this deployment sends no email, and with 429 past ten sends a minute per person or thirty a minute per organization.",
    security: [{ clerkBearerAuth: [] }],
    request: {
      params: z.object({ orgId: orgIdParamSchema }),
      body: { required: true, content: jsonContent(sendFeedbackRequestSchema) },
    },
    responses: {
      201: { description: "Feedback sent", content: jsonContent(sendFeedbackResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });
}
