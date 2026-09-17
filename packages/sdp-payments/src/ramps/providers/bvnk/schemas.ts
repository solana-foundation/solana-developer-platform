import type { CountryCode } from "@sdp/types";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import { CRYPTO_RAIL_ASSET_LABELS } from "@sdp/types/payment-rails";
import { z } from "zod";
import type { BvnkRuleEntity } from "./provider-data";
import {
  BVNK_EMPLOYMENT_STATUSES,
  BVNK_EXPECTED_VOLUME_CURRENCIES,
  BVNK_INDUSTRY_SECTORS,
  BVNK_INTENDED_USES,
  BVNK_PEP_STATUSES,
  BVNK_SOURCE_OF_FUNDS,
  BVNK_YEARLY_INCOMES,
} from "./requirements";

export const bvnkEstimateFiatCurrencySchema = z.enum(RAMP_FIAT_CURRENCIES);

export const bvnkEstimateFeeCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.union([bvnkEstimateFiatCurrencySchema, z.enum(Object.values(CRYPTO_RAIL_ASSET_LABELS))]));

export const bvnkComplianceDetailsSchema = z.object({
  partyDetails: z.array(z.record(z.string(), z.unknown())).min(1),
});
export type BvnkComplianceInput = z.infer<typeof bvnkComplianceDetailsSchema>;

export const bvnkSandboxPayinCurrencySchema = z.enum(["USD", "EUR"]);
export type BvnkSandboxPayinCurrency = z.infer<typeof bvnkSandboxPayinCurrencySchema>;

export const bvnkOfframpQuoteInputSchema = z.object({
  fiatCurrency: bvnkEstimateFiatCurrencySchema,
  paymentTransferId: z.string().min(1),
  bvnkOfframpWalletId: z.string().min(1),
  externalCustomerId: z.string().min(1),
  bvnkCompliance: bvnkComplianceDetailsSchema,
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

export const bvnkCustomerStatusSchema = z.enum([
  "INFO_REQUIRED",
  "PENDING",
  "ACTIONS_REQUIRED",
  "VERIFIED",
  "REJECTED",
  "TERMINATED",
]);
/** Customer webhooks also report terminal success as COMPLETED or APPROVED, which the v2 customer API never returns. */
export const bvnkCustomerWebhookStatusSchema = z.enum([
  ...bvnkCustomerStatusSchema.options,
  "COMPLETED",
  "APPROVED",
]);

const bvnkV2AddressSchema = z.object({
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  postalCode: z.string().min(1),
  stateCode: z.string().optional(),
  countryCode: z.string().min(2),
});

const bvnkV2TaxIdentificationSchema = z.object({
  number: z.string().min(1),
  taxResidenceCountryCode: z.string().min(2),
});

const bvnkV2EmploymentStatusSchema = z.enum(BVNK_EMPLOYMENT_STATUSES);

const bvnkV2SourceOfFundsSchema = z.enum([...BVNK_SOURCE_OF_FUNDS, "GIFT", "STUDENT_LOAN_GRANT"]);

const bvnkV2PepStatusSchema = z.enum([...BVNK_PEP_STATUSES, "STATE_OWNED"]);
const bvnkV2IntendedUseOfAccountSchema = z.enum(BVNK_INTENDED_USES);

const bvnkV2IncomeSchema = z.enum(BVNK_YEARLY_INCOMES);
const bvnkV2IndustrySectorSchema = z.enum(BVNK_INDUSTRY_SECTORS);

const bvnkV2ExpectedMonthlyVolumeSchema = z.object({
  amount: z.union([z.string().min(1), z.number().finite()]),
  currency: z.enum(BVNK_EXPECTED_VOLUME_CURRENCIES),
});
export const bvnkV2CddSchema = z.object({
  employmentStatus: bvnkV2EmploymentStatusSchema,
  sourceOfFunds: bvnkV2SourceOfFundsSchema,
  pepStatus: bvnkV2PepStatusSchema,
  intendedUseOfAccount: bvnkV2IntendedUseOfAccountSchema,
  expectedMonthlyVolume: bvnkV2ExpectedMonthlyVolumeSchema,
  estimatedYearlyIncome: bvnkV2IncomeSchema.optional(),
  employmentIndustrySector: bvnkV2IndustrySectorSchema.optional(),
});

const bvnkIndividualSchema = z.object({
  address: bvnkV2AddressSchema,
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  birthCountryCode: z.string().min(2),
  emailAddress: z.string().optional(),
  phoneNumber: z.string().optional(),
  description: z.string().optional(),
  placeOfBirth: z.string().optional(),
  documentNumber: z.string().optional(),
  nationality: z.string().min(2),
  taxIdentification: bvnkV2TaxIdentificationSchema,
  cdd: bvnkV2CddSchema.optional(),
});
export type BvnkCustomerIndividual = z.infer<typeof bvnkIndividualSchema>;

export interface CreateBvnkAgreementSessionInput {
  countryCode: CountryCode;
  idempotencyKey: string;
}

export interface SignBvnkAgreementSessionInput {
  reference: string;
  ipAddress: string;
}

/** BVNK-supplied links are persisted and re-served by the public API, so only https passes the boundary. */
const bvnkHttpsUrlSchema = z.url({ protocol: /^https$/ });

export const bvnkSessionAgreementSchema = z.object({
  status: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  url: bvnkHttpsUrlSchema,
  privacyPolicyUrl: bvnkHttpsUrlSchema,
});
export type BvnkSessionAgreement = z.infer<typeof bvnkSessionAgreementSchema>;

export const bvnkAgreementSessionSchema = z.object({
  reference: z.string().min(1),
  status: z.enum(["PENDING", "SIGNED", "DECLINED"]),
  agreements: z.array(bvnkSessionAgreementSchema),
});
export type BvnkAgreementSession = z.infer<typeof bvnkAgreementSessionSchema>;

export const bvnkCustomerCreatedSchema = z.object({
  reference: z.string().min(1),
  status: bvnkCustomerStatusSchema,
});
export type BvnkCustomerCreated = z.infer<typeof bvnkCustomerCreatedSchema>;

/**
 * Sumsub-side verification phase echoed by the v1 customer GET. The vocabulary is
 * undocumented and wider than init/pending/completed/failed (a value outside that set
 * surfaced live on 2026-09-16 right after details submission), and SDP never branches
 * on it: the KYC phase comes from `status`. Stored for support visibility only. The
 * block itself may arrive with neither key while Sumsub is being set up.
 */
export const bvnkVerificationStatusSchema = z.string().min(1);

export const bvnkCustomerSchema = z.object({
  reference: z.string().min(1),
  status: bvnkCustomerStatusSchema,
  verification: z
    .object({
      status: bvnkVerificationStatusSchema.optional(),
      url: bvnkHttpsUrlSchema.optional(),
    })
    .optional(),
});
export type BvnkCustomer = z.infer<typeof bvnkCustomerSchema>;

export interface CreateBvnkCustomerInput {
  idempotencyKey: string;
  externalReference: string;
  signedAgreementSessionReference: string;
  individual: BvnkCustomerIndividual;
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
  customerId?: string;
  profileId?: string;
}
export interface ListBvnkLedgerWalletProfilesV2Input {
  customerId?: string;
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
