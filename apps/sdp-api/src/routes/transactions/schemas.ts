import { z } from "zod";

export const submitTransactionSchema = z.object({
  transaction: z.string().min(1),
  transactionId: z.string().optional(),
  options: z
    .object({
      skipPreflight: z.boolean().optional(),
      commitment: z.enum(["processed", "confirmed", "finalized"]).optional(),
    })
    .optional(),
});

export const signTransactionSchema = z.object({
  transaction: z.string().min(1),
  walletId: z.string().optional(),
  metadata: z
    .object({
      operationType: z.string().optional(),
      tokenId: z.string().optional(),
      amount: z.string().optional(),
      destination: z.string().optional(),
    })
    .optional(),
});
