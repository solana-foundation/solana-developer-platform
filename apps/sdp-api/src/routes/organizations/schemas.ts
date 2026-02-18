import { z } from "zod";

const createOrgCustodySchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("fireblocks"),
    apiBaseUrl: z.string().url().optional(),
    assetId: z.string().min(1).optional(),
    vaultAccountId: z.string().min(1).optional(),
  }),
  z.object({
    provider: z.literal("privy"),
    apiBaseUrl: z.string().url().optional(),
    requestDelayMs: z.number().int().min(0).max(3000).optional(),
  }),
]);

export const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  email: z.string().email(),
  returnFullApiKey: z.boolean().optional(),
  custody: createOrgCustodySchema.optional(),
});

export const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  settings: z
    .object({
      defaultEnvironment: z.enum(["sandbox", "production"]).optional(),
      allowedIpAddresses: z.array(z.string()).optional(),
    })
    .optional(),
});
