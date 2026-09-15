import { z } from "zod";

export const policyControlInventoryQuerySchema = z.object({
  target: z.enum(["wallet", "api_key", "all"]).default("all"),
  status: z.enum(POLICY_CONTROL_INVENTORY_STATUSES).optional(),
  query: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

import { POLICY_CONTROL_INVENTORY_STATUSES } from "@sdp/types";
