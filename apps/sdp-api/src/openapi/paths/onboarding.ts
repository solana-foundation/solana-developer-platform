import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { errorResponseSchema } from "@/openapi/schemas/base";
import { errorResponses, jsonContent } from "./helpers";
import { onboardingStatusResponse } from "./responses";

export function registerOnboardingPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/onboarding/status",
    tags: ["Onboarding"],
    summary: "Get onboarding status",
    operationId: "getOnboardingStatus",
    description:
      "Reads the active Clerk organization's SDP link and onboarding setup. Requires a Clerk session with an organization claim and usable email, even when that Clerk organization has not been linked to SDP. API keys are not accepted. No project selection or tenant action is required. An unlinked organization returns linked: false with organization and setup null. A linked organization returns its details and default sandbox project's custody setup, including canManage. The API enforces active membership or a valid pending invitation. This read never provisions an organization, advances setup, or polls for linkage.",
    security: [{ clerkBearerAuth: [] }],
    responses: {
      200: {
        description: "Onboarding status",
        content: jsonContent(onboardingStatusResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });
}
