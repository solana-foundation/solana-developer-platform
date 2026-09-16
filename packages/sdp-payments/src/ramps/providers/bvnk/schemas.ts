import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import { z } from "zod";
import type { BvnkEntityType, BvnkRuleEntity } from "./provider-data";
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
  details: z.object({ errors: z.unknown() }).optional(),
});
export type BvnkErrorEnvelopeParse = ReturnType<typeof bvnkErrorEnvelopeSchema.safeParse>;

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

const bvnkV2CustomerStatusSchema = z.enum([
  "INFO_REQUIRED",
  "PENDING",
  "ACTIONS_REQUIRED",
  "VERIFIED",
  "REJECTED",
  "TERMINATED",
]);

const bvnkV2CustomerTypeSchema = z.enum(["COMPANY", "INDIVIDUAL"]);
const bvnkV2CustomerModelSchema = z.enum([
  "EMBEDDED",
  "RELIANCE",
  "CUSTOMER_VIRTUAL_ACCOUNTS",
  "EMBEDDED_BVNK_MANAGED",
  "EMBEDDED_SELF_MANAGED",
  "DOUBLE_EMBEDDED",
]);
const bvnkV2CustomerUseCaseSchema = z.enum([
  "FIAT",
  "CRYPTO",
  "STABLECOIN_PAYOUTS",
  "EMBEDDED_STABLECOIN_WALLETS",
  "EMBEDDED_FIAT_ACCOUNTS",
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

const bvnkV2IndividualSchema = z.object({
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
export type BvnkCustomerV2Individual = z.infer<typeof bvnkV2IndividualSchema>;

type BvnkCustomerV2UseCase = z.infer<typeof bvnkV2CustomerUseCaseSchema>;

export interface CreateBvnkCustomerV2Input {
  idempotencyKey: string;
  useCase: BvnkCustomerV2UseCase;
  reference?: string;
  individual: BvnkCustomerV2Individual;
}

const bvnkV2RequiredActionTargetSchema = z.object({
  kind: z.enum(["AGREEMENT", "DOCUMENT", "FIELD"]),
  assignedAgreementId: z.string().optional(),
  urn: z.string().optional(),
  version: z.string().optional(),
  title: z.string().optional(),
  locale: z.string().optional(),
  docSetType: z.string().optional(),
  types: z.array(z.string()).optional(),
  subTypes: z.array(z.string()).optional(),
  associateId: z.string().nullable().optional(),
  path: z.string().optional(),
});
const bvnkV2RequiredActionSchema = z.object({
  type: z.enum(["DATA", "USER_ROLE", "BLOCKER"]),
  code: z.string(),
  category: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["REQUIRED", "PROCESSING"]).optional(),
  target: bvnkV2RequiredActionTargetSchema.optional(),
});
const bvnkV2AuthenticatedLinkSchema = z.object({
  link: z.string().min(1),
  expiresAt: z.string().nullable(),
});
export const bvnkV2CustomerSummarySchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1),
  status: bvnkV2CustomerStatusSchema,
  type: bvnkV2CustomerTypeSchema,
  model: bvnkV2CustomerModelSchema,
  useCase: bvnkV2CustomerUseCaseSchema,
  name: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type BvnkCustomerV2 = z.infer<typeof bvnkV2CustomerSummarySchema>;
export const bvnkV2CustomerDetailSchema = bvnkV2CustomerSummarySchema.extend({
  authenticatedLink: bvnkV2AuthenticatedLinkSchema,
  requiredActions: z.array(bvnkV2RequiredActionSchema),
});
export type BvnkCustomerV2Detail = z.infer<typeof bvnkV2CustomerDetailSchema>;

const bvnkV2AgreementStatusSchema = z.enum(["PENDING", "ACCEPTED", "REJECTED"]);
const bvnkV2AgreementSchema = z.object({
  id: z.string().min(1),
  status: bvnkV2AgreementStatusSchema,
  declinable: z.boolean(),
  name: z.string().min(1),
  description: z.string().min(1),
});
export const bvnkV2AgreementsResponseSchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1),
  agreements: z.array(bvnkV2AgreementSchema),
  signingUrl: z.string().min(1),
});
export type BvnkAgreementsV2 = z.infer<typeof bvnkV2AgreementsResponseSchema>;
export const bvnkV2AgreementContentSchema = z.object({
  downloadUrl: z.string().min(1),
  expiresAt: z.string().nullable().optional(),
});
export type BvnkAgreementContentV2 = z.infer<typeof bvnkV2AgreementContentSchema>;
const bvnkV2AgreementActionTypeSchema = z.enum(["ACCEPT", "REJECT"]);
type BvnkAgreementActionTypeV2 = z.infer<typeof bvnkV2AgreementActionTypeSchema>;
interface BvnkAgreementActionV2 {
  agreementId: string;
  type: BvnkAgreementActionTypeV2;
}
export interface CreateBvnkAgreementsV2Input {
  idempotencyKey: string;
  reference: string;
  useCase: BvnkCustomerV2UseCase;
  customerType: BvnkEntityType;
  countryCode: string;
}
export interface RespondBvnkAgreementsV2Input {
  idempotencyKey: string;
  reference: string;
  actions: BvnkAgreementActionV2[];
}
// BVNK has no discriminator field on action results, so the success and error
// arms cannot be a discriminated union; both may appear in one response.
const bvnkV2AgreementActionResultSchema = z.object({
  agreementId: z.string().min(1),
  status: z.enum(["ACCEPTED", "REJECTED"]).optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
});
const bvnkV2PageableSchema = z
  .object({ pageNumber: z.number().int(), pageSize: z.number().int() })
  .optional();
export const bvnkV2AgreementActionResultsSchema = z.object({
  content: z.array(bvnkV2AgreementActionResultSchema),
  totalElements: z.number().int(),
  totalPages: z.number().int(),
  pageable: bvnkV2PageableSchema,
  hasNext: z.boolean(),
});
export type BvnkAgreementActionResultsV2 = z.infer<typeof bvnkV2AgreementActionResultsSchema>;

const bvnkV2AgreementSummarySchema = z.object({
  version: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  locale: z.string().nullable().optional(),
});
const bvnkV2AssignedAgreementSchema = z.object({
  id: z.string().min(1),
  agreement: bvnkV2AgreementSummarySchema,
  status: bvnkV2AgreementStatusSchema,
  respondedAt: z.string().nullable().optional(),
  respondedToDocumentChecksum: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export const bvnkV2AssignedAgreementsSchema = z.object({
  totalElements: z.number().int(),
  totalPages: z.number().int(),
  content: z.array(bvnkV2AssignedAgreementSchema),
  pageable: bvnkV2PageableSchema,
  hasNext: z.boolean(),
});
export type BvnkAssignedAgreementsV2 = z.infer<typeof bvnkV2AssignedAgreementsSchema>;

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
  id: z.string().optional(),
  reference: z.string().optional(),
  status: z.string().optional(),
  originator: z
    .object({ currency: z.string().optional(), walletId: z.string().optional() })
    .optional(),
});
export type BvnkRuleResponse = z.infer<typeof bvnkRuleResponseSchema>;
