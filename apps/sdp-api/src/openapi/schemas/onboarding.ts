import { z } from "./base";
import { apiKeyIdParamSchema, apiKeyPrefixSchema } from "./base";
import { organizationSchema } from "./organizations";

export const onboardingStatusResponseSchema = z
  .object({
    linked: z.boolean().openapi({ description: "Whether the Clerk org is linked." }),
    organization: organizationSchema
      .nullable()
      .openapi({ description: "Linked organization details, if available." }),
  })
  .openapi({ description: "Onboarding status response." });

export const linkOrganizationRequestSchema = z
  .object({
    name: z.string().optional().openapi({
      description: "Optional override for organization name.",
      example: "Solana Foundation",
    }),
    slug: z.string().optional().openapi({
      description: "Optional override for organization slug.",
      example: "solana-foundation",
    }),
  })
  .openapi({ description: "Optional fields for linking a Clerk org." });

export const linkOrganizationResponseSchema = z
  .object({
    linked: z.boolean().openapi({ description: "Whether the org is linked." }),
    organization: organizationSchema.openapi({ description: "Linked organization details." }),
    apiKey: z
      .object({
        id: apiKeyIdParamSchema,
        key: z.string().openapi({
          description: "Full API key. Only returned on first link.",
          example: "sk_test_example",
        }),
        keyPrefix: apiKeyPrefixSchema,
      })
      .nullable()
      .openapi({
        description:
          "Initial API key created during onboarding. Null when keys are created later via the UI or API.",
      }),
  })
  .openapi({ description: "Onboarding link response." });
