import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().max(500).optional(),
  environment: z.enum(["sandbox", "beta", "production"]).optional(),
  settings: z
    .object({
      rpcEndpoint: z.string().url().optional(),
      webhookUrl: z.string().url().optional(),
      metadata: z.record(z.string()).optional(),
    })
    .optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  environment: z.enum(["sandbox", "beta", "production"]).optional(),
  settings: z
    .object({
      rpcEndpoint: z.string().url().optional(),
      webhookUrl: z.string().url().optional(),
      metadata: z.record(z.string()).optional(),
    })
    .nullable()
    .optional(),
});

export const addMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(["admin", "developer", "viewer"]).optional(),
});

export const updateMemberSchema = z.object({
  role: z.enum(["admin", "developer", "viewer"]),
});
