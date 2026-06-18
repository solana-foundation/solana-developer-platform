import {
  COUNTERPARTY_EMPLOYMENT_STATUSES,
  COUNTERPARTY_ENTITY_TYPES,
  COUNTERPARTY_ID_TYPES,
  COUNTERPARTY_INDUSTRY_SECTORS,
  COUNTERPARTY_INTENDED_USE,
  COUNTERPARTY_PEP_STATUSES,
  COUNTERPARTY_SOURCE_OF_FUNDS,
  COUNTERPARTY_YEARLY_INCOME,
  COUNTRY_CODES,
} from "@sdp/types";
import { z } from "zod";
import { LIGHTSPARK_PAYOUT_CURRENCIES } from "@/lib/ramps/validation/lightspark";
import {
  rampCurrencyCodeSchema,
  rampDirectionSchema,
  rampFiatCurrencySchema,
} from "@/routes/payments/schemas";

const countryCodeSchema = z.enum(COUNTRY_CODES);
const currencyCodeSchema = z.string().trim().toUpperCase().length(3);
const subdivisionCodeSchema = z.string().min(1).max(16);

export const counterpartyAddressSchema = z.object({
  line1: z.string().min(1).max(512),
  line2: z.string().max(512).optional(),
  city: z.string().min(1).max(256),
  postalCode: z.string().max(32).optional(),
  countryCode: countryCodeSchema,
  subdivisionCode: subdivisionCodeSchema.optional(),
});

export const counterpartyIdTypeSchema = z.enum(COUNTERPARTY_ID_TYPES);

export const counterpartyGovernmentIdSchema = z.object({
  type: counterpartyIdTypeSchema,
  number: z.string().min(1).max(128),
  issueCountry: countryCodeSchema,
  subdivisionCode: subdivisionCodeSchema.optional(),
  issueDate: z.iso.date().optional(),
  expiryDate: z.iso.date().optional(),
});

export const counterpartyMonetaryAmountSchema = z.object({
  amount: z.string().min(1).max(32),
  currency: currencyCodeSchema,
});

export const counterpartyComplianceCddSchema = z.object({
  employmentStatus: z.enum(COUNTERPARTY_EMPLOYMENT_STATUSES),
  sourceOfFunds: z.enum(COUNTERPARTY_SOURCE_OF_FUNDS),
  pepStatus: z.enum(COUNTERPARTY_PEP_STATUSES),
  intendedUseOfAccount: z.enum(COUNTERPARTY_INTENDED_USE),
  expectedMonthlyVolume: counterpartyMonetaryAmountSchema,
  estimatedYearlyIncome: z.enum(COUNTERPARTY_YEARLY_INCOME),
  employmentIndustrySector: z.enum(COUNTERPARTY_INDUSTRY_SECTORS),
});

export const counterpartyTaxIdentificationSchema = z.object({
  number: z.string().min(1).max(64),
  residenceCountryCode: countryCodeSchema,
});

export const counterpartyComplianceSchema = z.object({
  taxIdentification: counterpartyTaxIdentificationSchema.optional(),
  nationality: countryCodeSchema.optional(),
  birthCountryCode: countryCodeSchema.optional(),
  cdd: counterpartyComplianceCddSchema.optional(),
});

export const counterpartyIdentitySchema = z.looseObject({
  firstName: z.string().min(1).max(256).optional(),
  middleName: z.string().max(256).optional(),
  lastName: z.string().min(1).max(256).optional(),
  secondLastName: z.string().max(256).optional(),
  dateOfBirth: z.iso.date().optional(),
  phone: z.string().min(1).max(64).optional(),
  address: counterpartyAddressSchema.optional(),
  birthCountryCode: countryCodeSchema.optional(),
  citizenshipCountryCode: countryCodeSchema.optional(),
  governmentId: counterpartyGovernmentIdSchema.optional(),
  compliance: counterpartyComplianceSchema.optional(),
});

export const counterpartyEntityTypeSchema = z.enum(COUNTERPARTY_ENTITY_TYPES);

export const counterpartyStatusSchema = z.enum(["active", "archived"]);

export const counterpartyIdSchema = z.string().min(1);

export const counterpartyIdParamsSchema = z.object({
  counterpartyId: counterpartyIdSchema,
});

const lightsparkPayoutCurrencySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(LIGHTSPARK_PAYOUT_CURRENCIES)
);

export const counterpartyRequirementsQuerySchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("moonpay"), direction: rampDirectionSchema }),
  z.object({
    provider: z.literal("bvnk"),
    direction: rampDirectionSchema,
    cryptoToken: rampCurrencyCodeSchema.optional(),
    fiatCurrency: rampFiatCurrencySchema.optional(),
    destinationWallet: z.string().min(1).optional(),
  }),
  z.discriminatedUnion("direction", [
    z.object({ provider: z.literal("lightspark"), direction: z.literal("onramp") }),
    z.object({
      provider: z.literal("lightspark"),
      direction: z.literal("offramp"),
      fiatCurrency: lightsparkPayoutCurrencySchema,
    }),
  ]),
]);

export const createCounterpartySchema = z.object({
  externalId: z.string().min(1).max(256).optional(),
  entityType: counterpartyEntityTypeSchema,
  displayName: z.string().min(1).max(512),
  email: z.email().max(512),
  identity: counterpartyIdentitySchema.optional(),
});

export const updateCounterpartyObjectSchema = z.object({
  externalId: z.string().min(1).max(256).nullable().optional(),
  entityType: counterpartyEntityTypeSchema.optional(),
  displayName: z.string().min(1).max(512).optional(),
  email: z.email().max(512).optional(),
  identity: counterpartyIdentitySchema.optional(),
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
