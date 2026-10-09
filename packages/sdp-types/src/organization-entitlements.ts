import { z } from "zod";

const providerFlagsSchema = z.record(z.string(), z.boolean());

/**
 * The entitlement half of `organizations.settings`: what the organization may
 * use, synced from Clerk metadata. The API loads it once per request during
 * authentication, for every actor, and gates read it from the request context.
 */
export const organizationEntitlementsSchema = z.object({
  enableProductionProject: z.boolean().optional(),
  providerOverrides: z
    .object({
      custody: providerFlagsSchema.optional(),
      compliance: providerFlagsSchema.optional(),
      ramps: providerFlagsSchema.optional(),
      earn: providerFlagsSchema.optional(),
    })
    .optional(),
});

export type OrganizationEntitlements = z.infer<typeof organizationEntitlementsSchema>;
