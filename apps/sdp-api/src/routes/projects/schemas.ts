import { z } from "zod";

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  settings: z
    .strictObject({
      webhookUrl: z.string().url().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
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
