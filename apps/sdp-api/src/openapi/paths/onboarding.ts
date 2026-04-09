import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { errorResponseSchema } from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { onboardingStatusResponse } from "./responses";

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
}
