import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
import { z } from "zod";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/**
 * @param t - The active message translator.
 * @param code - The validation code emitted by a counterparty form schema.
 * @returns The localized validation message.
 */
export function resolveCounterpartyValidationMessage(t: Translate, code: string): string {
  const keys: Record<string, MessageKey> = {
    required: "DashboardPayments.counterparty.validation.required",
    invalidEmail: "DashboardPayments.counterparty.validation.invalidEmail",
    invalidDate: "DashboardPayments.counterparty.validation.invalidDate",
    dateMustBePast: "DashboardPayments.counterparty.validation.dateMustBePast",
  };
  const key = keys[code];
  if (key === undefined) {
    throw new Error(`Unknown counterparty validation code: ${code}`);
  }
  return t(key);
}

/**
 * @param max - The maximum accepted string length.
 * @param min - The minimum accepted length when the string is present.
 * @returns A schema that converts an empty string to an omitted value.
 */
function optionalString(max: number, min: number) {
  const inner = z.string().min(min).max(max);
  return z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : undefined))
    .pipe(inner.optional());
}

/**
 * Returns the current UTC date as a `YYYY-MM-DD` string, so date-only values
 * can be compared lexicographically without timezone-boundary drift from
 * `Date` object comparisons.
 *
 * @returns The current UTC date in ISO date format.
 */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export const basicsSchema = z.object({
  entityType: z.enum(COUNTERPARTY_ENTITY_TYPES),
  displayName: z.string().trim().min(1, "required").max(512),
  email: z.string().trim().toLowerCase().pipe(z.email("invalidEmail").max(512)),
  externalId: optionalString(256, 1),
});

export const identitySchema = z.object({
  firstName: z.string().trim().min(1, "required").max(256),
  lastName: z.string().trim().min(1, "required").max(256),
  dateOfBirth: z
    .string()
    .trim()
    .pipe(
      z.iso
        .date("invalidDate")
        .refine((value) => value < todayIsoDate(), { message: "dateMustBePast" })
    ),
});

export const CRYPTO_ACCOUNT_NETWORKS = ["solana"] as const;
export type CryptoAccountNetwork = (typeof CRYPTO_ACCOUNT_NETWORKS)[number];

export const cryptoAccountSchema = z.object({
  label: optionalString(256, 1),
  network: z.enum(CRYPTO_ACCOUNT_NETWORKS),
  address: z.string().trim().min(1, "required").max(256),
});

export type CryptoAccountData = z.input<typeof cryptoAccountSchema>;
export type CryptoAccountClean = z.output<typeof cryptoAccountSchema>;

export type StepId = "basics" | "identity" | "review";

export type BasicsData = z.input<typeof basicsSchema>;
export type IdentityData = z.input<typeof identitySchema>;

export type BasicsClean = z.output<typeof basicsSchema>;
export type IdentityClean = z.output<typeof identitySchema>;
