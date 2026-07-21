import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { errorResponseSchema } from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { onboardingCompleteResponse, onboardingStatusResponse } from "./responses";

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
    path: "/v1/onboarding/complete",
    tags: ["Onboarding"],
    summary: "Complete organization onboarding",
    operationId: "completeOrganizationOnboarding",
    description:
      "Marks organization onboarding complete after verifying an RPC selection and active custody wallet.",
    security: [{ apiKeyAuth: [] }],
    responses: {
      200: {
        description: "Completed onboarding state",
        content: jsonContent(onboardingCompleteResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });
}
