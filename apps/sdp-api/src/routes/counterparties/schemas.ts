import {
  COUNTERPARTY_ACCOUNT_SUMMARY_TYPES,
  COUNTERPARTY_ENTITY_TYPES,
  COUNTRY_CODES,
} from "@sdp/types";
import { z } from "zod";
import { rampCurrencyCodeSchema, rampFiatCurrencySchema } from "@/routes/payments/schemas";

const countryCodeSchema = z.enum(COUNTRY_CODES);
const subdivisionCodeSchema = z.string().min(1).max(16);
const E164_PHONE_PATTERN = /^\+[1-9]\d{1,14}$/;

export const counterpartyAddressSchema = z.object({
  line1: z.string().min(1).max(512),
  line2: z.string().max(512).optional(),
  city: z.string().min(1).max(256),
  postalCode: z.string().max(32).optional(),
  countryCode: countryCodeSchema,
  subdivisionCode: subdivisionCodeSchema.optional(),
});

export const counterpartyIdentitySchema = z.object({
  firstName: z.string().min(1).max(256),
  middleName: z.string().max(256).optional(),
  lastName: z.string().min(1).max(256),
  secondLastName: z.string().max(256).optional(),
  dateOfBirth: z.iso.date().refine((value) => value < new Date().toISOString().slice(0, 10), {
    message: "dateOfBirth must be in the past",
  }),
  phone: z.string().regex(E164_PHONE_PATTERN, { message: "phone must be in E.164 format" }),
  address: counterpartyAddressSchema,
});

export const counterpartyEntityTypeSchema = z.enum(COUNTERPARTY_ENTITY_TYPES);

export const counterpartyStatusSchema = z.enum(["active", "archived"]);

export const counterpartyIdParamsSchema = z.object({
  counterpartyId: z.string().min(1),
});

export const counterpartyRequirementsQuerySchema = z.discriminatedUnion("direction", [
  z.object({
    provider: z.enum(["moonpay", "lightspark", "bvnk", "coinbase"], {
      error: "provider does not support onramp requirements",
    }),
    direction: z.literal("onramp"),
    cryptoToken: rampCurrencyCodeSchema,
    fiatCurrency: rampFiatCurrencySchema,
    destinationWallet: z.string().min(1),
  }),
  z.object({
    provider: z.enum(["moonpay", "lightspark", "bvnk", "moneygram"], {
      error: "provider does not support offramp requirements",
    }),
    direction: z.literal("offramp"),
    cryptoToken: rampCurrencyCodeSchema,
    fiatCurrency: rampFiatCurrencySchema,
  }),
]);

export const counterpartyBusinessIdentitySchema = z.strictObject({
  address: counterpartyAddressSchema,
});

const createCounterpartyBaseSchema = z.object({
  externalId: z.string().min(1).max(256).optional(),
  displayName: z.string().min(1).max(512),
  email: z.email().max(512),
});

export const createIndividualCounterpartySchema = createCounterpartyBaseSchema.extend({
  entityType: z.literal("individual"),
  identity: counterpartyIdentitySchema,
});

export const createBusinessCounterpartySchema = createCounterpartyBaseSchema.extend({
  entityType: z.literal("business"),
  identity: counterpartyBusinessIdentitySchema,
});

export const createCounterpartySchema = z.discriminatedUnion("entityType", [
  createIndividualCounterpartySchema,
  createBusinessCounterpartySchema,
]);

export const updateCounterpartyObjectSchema = z.object({
  externalId: z.string().min(1).max(256).nullable().optional(),
  entityType: counterpartyEntityTypeSchema.optional(),
  displayName: z.string().min(1).max(512).optional(),
  email: z.email().max(512).optional(),
  identity: z.union([counterpartyIdentitySchema, counterpartyBusinessIdentitySchema]).optional(),
});

export const updateCounterpartySchema = updateCounterpartyObjectSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one field must be provided" }
);

export const listCounterpartiesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: z.coerce.boolean().default(false),
});

export const listCounterpartyAccountsQuerySchema = z.object({
  type: z.enum(COUNTERPARTY_ACCOUNT_SUMMARY_TYPES).default("crypto_account"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(256).optional(),
  ids: z.string().trim().min(1).max(20000).optional(),
});
