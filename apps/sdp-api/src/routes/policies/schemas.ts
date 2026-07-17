import { z } from "zod";

export const policyControlInventoryQuerySchema = z.object({
  target: z.enum(["wallet", "api_key", "all"]).default("all"),
  status: z.enum(["default_allow", "draft", "active", "disabled"]).optional(),
  query: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
