import { z } from "zod";

export const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  email: z.string().email(),
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
