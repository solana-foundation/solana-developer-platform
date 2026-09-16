import type { CountryCode } from "@sdp/types";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
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

export const bvnkErrorEnvelopeSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  details: z
    .object({
      errors: z.record(z.string(), z.array(z.string())).optional(),
    })
    .optional(),
});
export type BvnkErrorEnvelopeParse = ReturnType<typeof bvnkErrorEnvelopeSchema.safeParse>;

/**
 * The ACCOUNTS-2000 envelope for a duplicate externalReference (probe Q7). Other
 * ACCOUNTS-2000 validation failures (session reuse, legal entity) share the code
 * but not this field error and must surface as-is instead of triggering recovery.
 */
export const bvnkCustomerConflictSchema = z.object({
  code: z.literal("ACCOUNTS-2000"),
  errors: z.object({ externalReference: z.array(z.string()).min(1) }),
});

export const bvnkCustomerStatusSchema = z.enum([
  "INFO_REQUIRED",
  "PENDING",
  "ACTIONS_REQUIRED",
  "VERIFIED",
  "REJECTED",
  "TERMINATED",
]);

/**
 * Sumsub-side verification phase echoed by the v1 customer GET. The vocabulary is
 * undocumented and wider than init/pending/completed/failed (a value outside that set
 * surfaced live on 2026-09-16 right after details submission), and SDP never branches
 * on it: the KYC phase comes from `status`. Stored for support visibility only. The
 * block itself may arrive with neither key while Sumsub is being set up.
 */
export const bvnkVerificationStatusSchema = z.string().min(1);

const bvnkAddressSchema = z.object({
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  postalCode: z.string().min(1),
  stateCode: z.string().optional(),
  countryCode: z.string().min(2),
});

const bvnkTaxIdentificationSchema = z.object({
  number: z.string().min(1),
  taxResidenceCountryCode: z.string().min(2),
});

const bvnkEmploymentStatusSchema = z.enum(BVNK_EMPLOYMENT_STATUSES);

const bvnkSourceOfFundsSchema = z.enum([...BVNK_SOURCE_OF_FUNDS, "GIFT", "STUDENT_LOAN_GRANT"]);

const bvnkPepStatusSchema = z.enum([...BVNK_PEP_STATUSES, "STATE_OWNED"]);
const bvnkIntendedUseOfAccountSchema = z.enum(BVNK_INTENDED_USES);

const bvnkIncomeSchema = z.enum(BVNK_YEARLY_INCOMES);
const bvnkIndustrySectorSchema = z.enum(BVNK_INDUSTRY_SECTORS);

const bvnkExpectedMonthlyVolumeSchema = z.object({
  amount: z.union([z.string().min(1), z.number().finite()]),
  currency: z.enum(BVNK_EXPECTED_VOLUME_CURRENCIES),
});
export const bvnkCddSchema = z.object({
  employmentStatus: bvnkEmploymentStatusSchema,
  sourceOfFunds: bvnkSourceOfFundsSchema,
  pepStatus: bvnkPepStatusSchema,
  intendedUseOfAccount: bvnkIntendedUseOfAccountSchema,
  expectedMonthlyVolume: bvnkExpectedMonthlyVolumeSchema,
  estimatedYearlyIncome: bvnkIncomeSchema.optional(),
  employmentIndustrySector: bvnkIndustrySectorSchema.optional(),
});

const bvnkIndividualSchema = z.object({
  address: bvnkAddressSchema,
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
  taxIdentification: bvnkTaxIdentificationSchema,
  cdd: bvnkCddSchema.optional(),
});
export type BvnkCustomerIndividual = z.infer<typeof bvnkIndividualSchema>;

export interface CreateBvnkAgreementSessionInput {
  countryCode: CountryCode;
}

export interface SignBvnkAgreementSessionInput {
  reference: string;
  ipAddress: string;
}

const bvnkSessionAgreementSchema = z.object({
  status: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  url: z.url(),
  privacyPolicyUrl: z.url(),
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
 * The v1 customer GET also drives status refreshes during states where BVNK may
 * omit the individual block, so `individual` is optional at the top level only.
 */
export const bvnkCustomerSchema = z.object({
  reference: z.string().min(1),
  status: bvnkCustomerStatusSchema,
  verification: z
    .object({
      status: bvnkVerificationStatusSchema.optional(),
      url: z.url().optional(),
    })
    .optional(),
  individual: z
    .object({
      person: z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        dateOfBirth: z.string().min(1),
        address: bvnkAddressSchema.extend({
          postalCode: z.string().optional(),
          countryCode: z.string().length(2),
        }),
      }),
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

export const bvnkCustomerSearchV2Schema = z.object({
  content: z.array(
    z.object({
      id: z.string().min(1),
      status: bvnkCustomerStatusSchema,
    })
  ),
});
export type BvnkCustomerSearchV2 = z.infer<typeof bvnkCustomerSearchV2Schema>;

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

const bvnkChannelAddressSchema = z.object({
  network: z.string().optional(),
  address: z.string().optional(),
  uri: z.string().optional(),
});
export const bvnkChannelResponseSchema = z.object({
  uuid: z.string().optional(),
  reference: z.string().optional(),
  status: z.string().optional(),
  address: z.string().optional(),
  network: z.string().optional(),
  alternatives: z.array(bvnkChannelAddressSchema).optional(),
});
export type BvnkChannelAddress = z.infer<typeof bvnkChannelAddressSchema>;
export type BvnkChannelResponse = z.infer<typeof bvnkChannelResponseSchema>;

export const bvnkPayoutEstimateResponseSchema = z.object({
  walletCurrency: z.string(),
  walletRequiredAmount: z.number(),
  paidCurrency: z.string(),
  paidRequiredAmount: z.number(),
  feeCurrency: z.string(),
  feePredictedAmount: z.number(),
  networkFeeCurrency: z.string(),
  networkFeePredictedAmount: z.number(),
  totalWalletAmount: z.number(),
  exchangeRate: z.number(),
});
export type BvnkPayoutEstimateResponse = z.infer<typeof bvnkPayoutEstimateResponseSchema>;

export const bvnkQuoteEstimateResponseSchema = z.object({
  amountIn: z.number(),
  amountOut: z.number(),
  acceptanceExpiryDate: z.number(),
  payInMethod: z.object({ settlementCurrency: z.string() }),
  fees: z.object({ value: z.object({ service: z.number(), processing: z.number() }) }),
});

export interface CreateBvnkOnrampRuleInput {
  reference: string;
  walletId: string;
  currency: string;
  network: string;
  beneficiaryAddress: string;
  entity: BvnkRuleEntity;
}

export const bvnkRuleResponseSchema = z.object({
  id: z.string().min(1),
  reference: z.string().optional(),
  status: z.string().optional(),
  originator: z
    .object({ currency: z.string().optional(), walletId: z.string().optional() })
    .optional(),
});
export type BvnkRuleResponse = z.infer<typeof bvnkRuleResponseSchema>;
