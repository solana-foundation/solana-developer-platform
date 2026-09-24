import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
import { z } from "zod";

/** A base58 Solana public key: 32 to 44 characters of the base58 alphabet. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function optionalTrimmed<T extends z.ZodString>(inner: T) {
  return z
    .string()
    .trim()
    .transform((value) => (value.length > 0 ? value : undefined))
    .pipe(inner.optional());
}

/**
 * The one contact form: who they are, a first address to pay them at, and your own reference.
 * The address is optional and attached once the contact exists; an empty field means none.
 */
export const basicsSchema = z.object({
  entityType: z.enum(COUNTERPARTY_ENTITY_TYPES),
  displayName: z.string().trim().min(1, "required").max(512),
  walletAddress: optionalTrimmed(z.string().regex(SOLANA_ADDRESS, "invalidAddress")),
  externalId: optionalTrimmed(z.string().min(1).max(256)),
});

export const CRYPTO_ACCOUNT_NETWORKS = ["solana"] as const;
export type CryptoAccountNetwork = (typeof CRYPTO_ACCOUNT_NETWORKS)[number];

export type BasicsData = z.input<typeof basicsSchema>;

export type BasicsClean = z.output<typeof basicsSchema>;
