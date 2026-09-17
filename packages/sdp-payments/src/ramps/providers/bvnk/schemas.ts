import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import { CRYPTO_RAIL_ASSET_LABELS } from "@sdp/types/payment-rails";
import { z } from "zod";
import type { BvnkRuleEntity } from "./provider-data";

export const bvnkEstimateFiatCurrencySchema = z.enum(RAMP_FIAT_CURRENCIES);

export const bvnkEstimateFeeCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.union([bvnkEstimateFiatCurrencySchema, z.enum(Object.values(CRYPTO_RAIL_ASSET_LABELS))]));

export const bvnkSandboxPayinCurrencySchema = z.enum(["USD", "EUR"]);
export type BvnkSandboxPayinCurrency = z.infer<typeof bvnkSandboxPayinCurrencySchema>;

export const bvnkOfframpQuoteInputSchema = z.object({
  fiatCurrency: bvnkEstimateFiatCurrencySchema,
  paymentTransferId: z.string().min(1),
  bvnkOfframpWalletId: z.string().min(1),
  externalCustomerId: z.string().min(1),
  contactId: z.string().min(1),
});

export const bvnkOnrampTransferProviderDataSchema = z.object({
  bvnk: z.object({
    ruleId: z.string().min(1),
    ruleStatus: z.string().min(1).optional(),
    fundingWalletId: z.string().min(1),
  }),
});
export type BvnkOnrampTransferProviderData = z.infer<typeof bvnkOnrampTransferProviderDataSchema>;

export const bvnkErrorEnvelopeSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  details: z.object({ errors: z.unknown() }).optional(),
});
export type BvnkErrorEnvelopeParse = ReturnType<typeof bvnkErrorEnvelopeSchema.safeParse>;

const bvnkChannelAddressSchema = z.object({
  network: z.string().trim().toUpperCase(),
  address: z.string().min(1),
});
export const bvnkChannelResponseSchema = z.object({
  uuid: z.string().min(1),
  address: z.string().min(1),
  network: z.string().trim().toUpperCase(),
  alternatives: z.array(bvnkChannelAddressSchema).optional(),
});
export type BvnkChannelAddress = z.infer<typeof bvnkChannelAddressSchema>;
export type BvnkChannelResponse = z.infer<typeof bvnkChannelResponseSchema>;

export const bvnkPayoutEstimateResponseSchema = z
  .object({
    walletCurrency: z.string(),
    walletRequiredAmount: z.number().positive(),
    paidCurrency: z.string(),
    paidRequiredAmount: z.number().positive(),
    feeCurrency: bvnkEstimateFeeCurrencySchema,
    feePredictedAmount: z.number().nonnegative(),
    networkFeeCurrency: bvnkEstimateFeeCurrencySchema,
    networkFeePredictedAmount: z.number().nonnegative(),
    totalWalletAmount: z.number(),
    exchangeRate: z.number(),
  })
  .refine(
    (estimate) =>
      estimate.feePredictedAmount === 0 ||
      estimate.networkFeePredictedAmount === 0 ||
      estimate.feeCurrency === estimate.networkFeeCurrency,
    { message: "BVNK returned fees in multiple currencies for this estimate" }
  );
export type BvnkPayoutEstimateResponse = z.infer<typeof bvnkPayoutEstimateResponseSchema>;

export const bvnkQuoteEstimateResponseSchema = z.object({
  amountIn: z.number().positive(),
  amountOut: z.number().positive(),
  acceptanceExpiryDate: z.number(),
  payInMethod: z.object({ settlementCurrency: bvnkEstimateFeeCurrencySchema }),
  fees: z.object({
    value: z.object({
      service: z.number().nonnegative(),
      processing: z.number().nonnegative(),
    }),
  }),
});

export interface CreateBvnkOnrampRuleInput {
  reference: string;
  walletId: string;
  currency: string;
  network: string;
  beneficiaryAddress: string;
  entity: BvnkRuleEntity;
}

const bvnkV2PageableSchema = z
  .object({ pageNumber: z.number().int(), pageSize: z.number().int() })
  .optional();

const bvnkV2WalletProfileSchema = z.object({
  id: z.string().min(1),
  currencies: z.array(z.string().min(1)),
  methods: z.array(z.string().min(1)),
});
export const bvnkV2WalletProfilesSchema = z.object({
  totalElements: z.number().int(),
  totalPages: z.number().int(),
  content: z.array(bvnkV2WalletProfileSchema),
  pageable: bvnkV2PageableSchema,
  hasNext: z.boolean(),
});
export type BvnkLedgerWalletProfileV2 = z.infer<typeof bvnkV2WalletProfileSchema>;
export type BvnkLedgerWalletProfilesV2 = z.infer<typeof bvnkV2WalletProfilesSchema>;
export interface CreateBvnkLedgerWalletV2Input {
  idempotencyKey: string;
  currency: string;
  name: string;
  profileId?: string;
}
export interface ListBvnkLedgerWalletProfilesV2Input {
  currency?: string;
}

const bvnkV2BankNidSchema = z.object({
  value: z.string().min(1),
  type: z.enum(["ROUTING_NUMBER", "SORT_CODE", "OTHER"]).optional(),
});
const bvnkV2BankDetailsSchema = z.object({
  name: z.string().min(1),
  bic: z.string().min(1),
  nid: bvnkV2BankNidSchema.optional(),
});
const bvnkV2PaymentInstrumentSchema = z.object({
  type: z.literal("FIAT"),
  accountHolderName: z.string().min(1),
  accountNumber: z.string().min(1),
  bankDetails: bvnkV2BankDetailsSchema,
  remittanceInformationPrefix: z.string().optional(),
});
export const bvnkV2LedgerWalletSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["ACTIVE", "INACTIVE", "TERMINATED"]),
  customer: z.object({ id: z.string().min(1), name: z.string().optional() }).optional(),
  balance: z.object({ amount: z.number(), currency: z.string().min(1) }).optional(),
  paymentInstruments: z.array(bvnkV2PaymentInstrumentSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type BvnkLedgerWalletV2 = z.infer<typeof bvnkV2LedgerWalletSchema>;

export const bvnkRuleResponseSchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1),
  status: z.string().min(1),
});
export type BvnkRuleResponse = z.infer<typeof bvnkRuleResponseSchema>;

/**
 * Optional-string lanes BVNK reports as explicit nulls when absent; normalized
 * to undefined at the parse boundary so consumers keep `T | undefined`.
 */
const bvnkNullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)
  .optional();

const bvnkContactV3AddressSchema = z.object({
  addressLine1: z.string().min(1),
  addressLine2: bvnkNullableString,
  city: z.string().min(1),
  region: bvnkNullableString,
  stateCode: bvnkNullableString,
  postalCode: bvnkNullableString,
  country: z.string().min(2),
});
export type BvnkContactV3Address = z.infer<typeof bvnkContactV3AddressSchema>;

const bvnkContactV3IndividualSchema = z.object({
  type: z.literal("INDIVIDUAL"),
  relationshipType: z.enum(["THIRD_PARTY", "SELF_OWNED"]),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  address: bvnkContactV3AddressSchema.optional(),
});

const bvnkContactV3CompanySchema = z.object({
  type: z.literal("COMPANY"),
  relationshipType: z.enum(["THIRD_PARTY", "SELF_OWNED"]),
  legalName: z.string().min(1),
  registrationNumber: z.string().optional(),
  address: bvnkContactV3AddressSchema.optional(),
});

export const bvnkContactV3EntitySchema = z.discriminatedUnion("type", [
  bvnkContactV3IndividualSchema,
  bvnkContactV3CompanySchema,
]);
export type BvnkContactV3Entity = z.infer<typeof bvnkContactV3EntitySchema>;

export const createBvnkContactV3InputSchema = z.object({
  description: z.string().min(1),
  entity: bvnkContactV3EntitySchema,
});
export type CreateBvnkContactV3Input = z.infer<typeof createBvnkContactV3InputSchema>;

export const bvnkContactV3Schema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  entity: bvnkContactV3EntitySchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type BvnkContactV3 = z.infer<typeof bvnkContactV3Schema>;

export const bvnkContactsV3ListResponseSchema = z.object({
  content: z.array(bvnkContactV3Schema),
  pageable: bvnkV2PageableSchema,
  hasNext: z.boolean(),
});
export type BvnkContactsV3ListResponse = z.infer<typeof bvnkContactsV3ListResponseSchema>;
