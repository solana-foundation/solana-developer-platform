import { z } from "./base";
import { organizationSchema } from "./organizations";

export const organizationOnboardingSetupSchema = z.object({
  status: z.enum(["not_started", "in_progress", "complete"]),
  currentStep: z.enum(["rpc", "custody", "complete"]),
  rpcProvider: z.string().nullable(),
  custodyProvider: z.string().nullable(),
  completedAt: z.string().nullable(),
  version: z.number().int().positive(),
  canManage: z.boolean(),
});

export const onboardingCompleteRequestSchema = z.object({
  custodyProvider: z.string().min(1),
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

export const onboardingCompleteResponseSchema = z
  .object({ setup: organizationOnboardingSetupSchema })
  .openapi({ description: "Completed organization onboarding state." });
