import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
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

export const addressSchema = z.object({
  line1: z.string().trim().min(1, "Required").max(512),
  line2: optionalString(512, 0),
  city: z.string().trim().min(1, "Required").max(256),
  postalCode: optionalString(32, 0),
  countryCode: z.string().trim().toUpperCase().min(2, "Use a 2-letter code (e.g. US)").max(8),
  subdivisionCode: optionalUppercase(16),
});

export type StepId = "basics" | "identity" | "address" | "review";

export type BasicsData = z.input<typeof basicsSchema>;
export type IdentityData = z.input<typeof identitySchema>;
export type AddressData = z.input<typeof addressSchema>;

export type BasicsClean = z.output<typeof basicsSchema>;
export type IdentityClean = z.output<typeof identitySchema>;
export type AddressClean = z.output<typeof addressSchema>;
