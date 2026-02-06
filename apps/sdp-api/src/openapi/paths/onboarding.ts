import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { errorResponseSchema, linkOrganizationRequestSchema } from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { linkOrganizationResponse, onboardingStatusResponse } from "./responses";

export function registerOnboardingPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/onboarding/status",
    tags: ["Onboarding"],
    summary: "Get onboarding status",
    operationId: "getOnboardingStatus",
    description: "Returns whether the active Clerk organization is linked.",
    security: [{ apiKeyAuth: [] }],
    responses: {
      200: {
        description: "Onboarding status",
        content: jsonContent(onboardingStatusResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/onboarding/link-org",
    tags: ["Onboarding"],
    summary: "Link Clerk organization",
    operationId: "linkOnboardingOrganization",
    description: "Creates and links an SDP organization to the active Clerk org.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: false,
        content: jsonContent(linkOrganizationRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Organization linked",
        content: jsonContent(linkOrganizationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });
}
