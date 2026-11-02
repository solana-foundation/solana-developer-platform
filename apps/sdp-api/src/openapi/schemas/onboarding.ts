import { z } from "zod";
import { orgCustodyProviderSchema } from "./custody";
import { organizationSchema } from "./organizations";

export const organizationOnboardingSetupSchema = z.object({
  custodyProviders: z.array(orgCustodyProviderSchema).openapi({
    description:
      "Custody providers with an active Managed config or active BYOK connection in the default sandbox project, in provider-catalog order.",
  }),
  canManage: z.boolean(),
});

export const onboardingStatusResponseSchema = z
  .object({
    linked: z.boolean().openapi({ description: "Whether the Clerk org is linked." }),
    organization: organizationSchema
      .nullable()
      .openapi({ description: "Linked organization details, if available." }),
    setup: organizationOnboardingSetupSchema.nullable(),
  })
  .openapi({ description: "Onboarding status response." });
