import { z } from "zod";

export const addEntrySchema = z.object({
  type: z.enum(["email", "domain"]),
  value: z.string().min(1),
  tier: z.enum(["standard", "pro", "enterprise"]).optional(),
  notes: z.string().max(500).optional(),
});
