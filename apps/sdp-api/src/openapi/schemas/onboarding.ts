import { z } from "./base";
import { organizationSchema } from "./organizations";

export const onboardingStatusResponseSchema = z
  .object({
    linked: z.boolean().openapi({ description: "Whether the Clerk org is linked." }),
    organization: organizationSchema
      .nullable()
      .openapi({ description: "Linked organization details, if available." }),
  })
  .openapi({ description: "Onboarding status response." });
