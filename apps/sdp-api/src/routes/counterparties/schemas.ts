import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types/counterparties";
import { COUNTERPARTY_ACCOUNT_SUMMARY_TYPES } from "@sdp/types/payments";
import { z } from "zod";
import { queryBooleanSchema } from "@/openapi/schemas/base";
import {
  offrampCryptoRailSchema,
  onrampCryptoRailSchema,
  rampDirectionSchema,
  rampFiatCurrencySchema,
} from "@/routes/payments/ramps/schemas";

export const counterpartyEntityTypeSchema = z.enum(COUNTERPARTY_ENTITY_TYPES);

export const counterpartyStatusSchema = z.enum(["active", "archived"]);

export const counterpartyIdParamsSchema = z.object({
  counterpartyId: z.string().min(1),
});

export const counterpartyRequirementsQuerySchema = z.discriminatedUnion("direction", [
  z
    .object({
      provider: z.enum(["moonpay", "stripe", "hercle"], {
        error: "provider does not support onramp requirements",
      }),
      direction: z.literal("onramp"),
      assetRail: onrampCryptoRailSchema,
      fiatCurrency: rampFiatCurrencySchema,
      destinationCustodyWalletId: z
        .string({ error: "destinationCustodyWalletId is required for onramp requirements" })
        .min(1, { error: "destinationCustodyWalletId is required for onramp requirements" }),
    })
    .strict(),
  z
    .object({
      provider: z.enum(["moonpay"], {
        error: "provider does not support offramp requirements",
      }),
      direction: z.literal("offramp"),
      assetRail: offrampCryptoRailSchema,
      fiatCurrency: rampFiatCurrencySchema,
    })
    .strict(),
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

/**
 * The fields a `collect` answer asked for, by key.
 * The provider checks them against its own fields and passes them on; SDP stores none of them.
 */
const collectedFieldDataSchema = z.record(z.string().min(1).max(128), z.string().max(1024));

export const submitCounterpartyRequirementsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("moonpay"), direction: rampDirectionSchema }),
  z.object({ provider: z.literal("stripe"), direction: rampDirectionSchema }),
  z.object({
    provider: z.literal("hercle"),
    direction: z.literal("onramp", { error: "hercle does not support offramp requirements" }),
    collectedData: collectedFieldDataSchema.default({}),
  }),
]);
