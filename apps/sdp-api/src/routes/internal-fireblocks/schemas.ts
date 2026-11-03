import { z } from "zod";

export const fireblocksDestinationQuerySchema = z
  .object({
    walletId: z.string().min(1).max(200),
    counterpartyId: z.string().min(1).max(200),
    accountId: z.string().min(1).max(200),
    address: z.string().min(32).max(44),
    token: z.string().min(1).max(64),
  })
  .strict();
