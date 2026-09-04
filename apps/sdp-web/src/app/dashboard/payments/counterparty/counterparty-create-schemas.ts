import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
import { z } from "zod";

export const basicsSchema = z.object({
  entityType: z.enum(COUNTERPARTY_ENTITY_TYPES),
  displayName: z.string().trim().min(1, "required").max(512),
  externalId: z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : undefined))
    .pipe(z.string().min(1).max(256).optional()),
});

export const CRYPTO_ACCOUNT_NETWORKS = ["solana"] as const;
export type CryptoAccountNetwork = (typeof CRYPTO_ACCOUNT_NETWORKS)[number];

export type BasicsData = z.input<typeof basicsSchema>;

export type BasicsClean = z.output<typeof basicsSchema>;
