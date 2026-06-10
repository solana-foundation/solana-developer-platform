import { COUNTERPARTY_ENTITY_TYPES, COUNTRY_CODES } from "@sdp/types";
import { z } from "zod";

// Empty string -> undefined, with bounds applied when present.
function optionalString(max: number, min = 1) {
  const inner = z.string().min(min).max(max);
  return z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : undefined))
    .pipe(inner.optional());
}

function optionalUppercase(max: number, min = 1) {
  const inner = z.string().min(min).max(max);
  return z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => (v.length > 0 ? v : undefined))
    .pipe(inner.optional());
}

const optionalIsoDate = z
  .string()
  .trim()
  .transform((v) => (v.length > 0 ? v : undefined))
  .pipe(z.iso.date().optional());

export const basicsSchema = z.object({
  entityType: z.enum(COUNTERPARTY_ENTITY_TYPES),
  displayName: z.string().trim().min(1, "Required").max(512),
  email: z.string().trim().toLowerCase().pipe(z.email("Invalid email").max(512)),
  externalId: optionalString(256),
});

export const identitySchema = z.object({
  firstName: optionalString(256),
  lastName: optionalString(256),
  dateOfBirth: optionalIsoDate,
  phone: optionalString(64),
});

export const addressSchema = z
  .object({
    line1: z.string().trim().min(1, "Required").max(512),
    line2: optionalString(512, 0),
    city: z.string().trim().min(1, "Required").max(256),
    postalCode: optionalString(32, 0),
    countryCode: enumField(COUNTRY_CODES, "Select a country"),
    subdivisionCode: optionalUppercase(16),
  })
  .refine((v) => v.countryCode !== "US" || (v.subdivisionCode ?? "").length === 2, {
    message: "Select a state",
    path: ["subdivisionCode"],
  });

function enumField<const T extends readonly string[]>(values: T, message = "Required") {
  return z
    .string()
    .refine((v): v is T[number] => (values as readonly string[]).includes(v), message);
}

// Only Solana is accepted for now; the list is the seam for adding networks later.
export const CRYPTO_ACCOUNT_NETWORKS = ["solana"] as const;
export type CryptoAccountNetwork = (typeof CRYPTO_ACCOUNT_NETWORKS)[number];

export const cryptoAccountSchema = z.object({
  label: optionalString(256),
  network: z.enum(CRYPTO_ACCOUNT_NETWORKS),
  address: z.string().trim().min(1, "Required").max(256),
});

export type CryptoAccountData = z.input<typeof cryptoAccountSchema>;
export type CryptoAccountClean = z.output<typeof cryptoAccountSchema>;

export type StepId = "basics" | "identity" | "address" | "review";

export type BasicsData = z.input<typeof basicsSchema>;
export type IdentityData = z.input<typeof identitySchema>;
export type AddressData = z.input<typeof addressSchema>;

export type BasicsClean = z.output<typeof basicsSchema>;
export type IdentityClean = z.output<typeof identitySchema>;
export type AddressClean = z.output<typeof addressSchema>;
