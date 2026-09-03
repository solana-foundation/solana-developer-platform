import { COUNTERPARTY_ACCOUNT_SUMMARY_TYPES, COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
import { z } from "zod";
import { queryBooleanSchema } from "@/openapi/schemas/base";
import {
  rampCurrencyCodeSchema,
  rampDestinationCountrySchema,
  rampFiatCurrencySchema,
} from "@/routes/payments/schemas";

export const counterpartyEntityTypeSchema = z.enum(COUNTERPARTY_ENTITY_TYPES);

export const counterpartyStatusSchema = z.enum(["active", "archived"]);

export const counterpartyIdParamsSchema = z.object({
  counterpartyId: z.string().min(1),
});

export const counterpartyRequirementsQuerySchema = z.discriminatedUnion("direction", [
  z
    .object({
      provider: z.enum(
        ["moonpay", "lightspark", "bvnk", "moneygram", "coinbase", "mural", "stripe"],
        {
          error: "provider does not support onramp requirements",
        }
      ),
      direction: z.literal("onramp"),
      cryptoToken: rampCurrencyCodeSchema,
      fiatCurrency: rampFiatCurrencySchema,
      destinationWallet: z
        .string({ error: "destinationWallet is required for onramp requirements" })
        .min(1, { error: "destinationWallet is required for onramp requirements" }),
    })
    .strict(),
  z.discriminatedUnion("provider", [
    z
      .object({
        provider: z.literal("lightspark"),
        direction: z.literal("offramp"),
        cryptoToken: rampCurrencyCodeSchema,
        fiatCurrency: rampFiatCurrencySchema,
        destinationCountry: rampDestinationCountrySchema.optional(),
      })
      .strict(),
    z
      .object({
        provider: z.enum(["moonpay", "bvnk", "moneygram", "mural"], {
          error: "provider does not support offramp requirements",
        }),
        direction: z.literal("offramp"),
        cryptoToken: rampCurrencyCodeSchema,
        fiatCurrency: rampFiatCurrencySchema,
      })
      .strict(),
  ]),
]);

export const createCounterpartySchema = z.object({
  externalId: z.string().min(1).max(256).optional(),
  entityType: counterpartyEntityTypeSchema,
  displayName: z.string().min(1).max(512),
});

export const updateCounterpartyObjectSchema = z.object({
  externalId: z.string().min(1).max(256).nullable().optional(),
  entityType: counterpartyEntityTypeSchema.optional(),
  displayName: z.string().min(1).max(512).optional(),
});

export const updateCounterpartySchema = updateCounterpartyObjectSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one field must be provided" }
);

export const listCounterpartiesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: queryBooleanSchema.default(false),
});

export const listCounterpartyAccountsQuerySchema = z.object({
  type: z.enum(COUNTERPARTY_ACCOUNT_SUMMARY_TYPES).default("crypto_account"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(256).optional(),
  ids: z.string().trim().min(1).max(20000).optional(),
});
