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
