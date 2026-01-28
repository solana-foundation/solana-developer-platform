import { z } from "zod";

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  role: z.enum(["api_admin", "api_developer", "api_readonly"]).optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  allowedIps: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export const apiKeyUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  allowedIps: z.array(z.string()).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const apiKeyRotateSchema = z.object({
  gracePeriodHours: z.number().min(0).max(168).optional(), // Max 7 days
});
