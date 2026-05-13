import { z } from "zod";

export const complianceIntentSchema = z.enum([
  "transfer_destination",
  "wallet_address_addition",
  "unknown",
]);

export const screenAddressSchema = z.object({
  address: z.string().min(1),
  network: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .default("solana")
    .transform((value) => value.trim().toLowerCase()),
  intent: complianceIntentSchema.optional().default("unknown"),
});
