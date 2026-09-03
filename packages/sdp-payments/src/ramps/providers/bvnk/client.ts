import { assertValidAddress } from "@sdp/solana/address";
import {
  compareDecimalAmounts,
  formatDecimalAmount,
  isDecimalString,
  parseDecimalAmount,
  toNumberAmount,
} from "@sdp/solana/amount";
import type {
  Counterparty,
  PaymentRampEstimate,
  PaymentRampEstimateFees,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import {
  type CryptoRailId,
  getCryptoRailAssetLabel,
  type RampCurrencyLimit,
} from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { decimalStringFromNumber, divideDecimalAmounts } from "../../../decimal";
import {
  badRequest,
  internalError,
  providerNotConfigured,
  providerUnavailable,
  SdpPaymentsError,
} from "../../../errors";
import { hmacSha256Base64 } from "../../../hash";
import { type ProviderRequestInit, providerFetch } from "../../fetch";
import {
  isActiveIso4217CurrencyCode,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  rampId,
  SOLANA_ASSET_TO_RAIL,
  UNREPORTED_COUNTRY_SUPPORT,
  unreportedCurrencyLimit,
} from "../../shared";
import type {
  ProviderDeclaredRailSupport,
  ProviderRailSupportDistillation,
  RampDiscoveryContext,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampProvider,
  RampRuntimeContext,
  ValidateCounterpartyOptions,
} from "../../types";
import { validateBvnkCounterparty } from "./counterparty";
import {
  type BvnkComplianceInput,
  type BvnkEntityType,
  type BvnkNetwork,
  type BvnkRuleEntity,
  buildBvnkOfframpReference,
  normalizeBvnkCurrencyAndNetwork,
} from "./provider-data";

const BVNK_PRODUCTION_API_URL = "https://api.bvnk.com";
const BVNK_SANDBOX_API_URL = "https://api.sandbox.bvnk.com";
const bvnkEstimateFiatCurrencySchema = z.enum(RAMP_FIAT_CURRENCIES);

export const BVNK_DECLARED_RAIL_SUPPORT = {
  onramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: ["individual"],
  },
  offramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: ["individual", "business"],
  },
} as const satisfies ProviderDeclaredRailSupport;

interface BvnkSandboxBankAccount {
  accountNumber: string;
  accountNumberFormat: string;
  bankCode?: string;
}

// SANDBOX ONLY: synthetic originator (fiat sender) bank accounts for pay-in
// simulations. The real buyer's funding bank is never stored; BVNK just needs
// a format-valid account to accept the simulated deposit. Never used in prod.
const SANDBOX_ORIGINATOR_BANK_ACCOUNTS: Record<string, BvnkSandboxBankAccount> = {
  // biome-ignore lint/security/noSecrets: synthetic sandbox account, not a credential
  USD: { accountNumber: "000123456789", accountNumberFormat: "ABA", bankCode: "021000021" },
};
const SANDBOX_ORIGINATOR_BANK_ACCOUNT_FALLBACK: BvnkSandboxBankAccount = {
  // biome-ignore lint/security/noSecrets: synthetic sandbox account, not a credential
  accountNumber: "GB29NWBK60161331926819",
  accountNumberFormat: "IBAN",
};

function sandboxOriginatorBankAccount(currency: string): BvnkSandboxBankAccount {
  return SANDBOX_ORIGINATOR_BANK_ACCOUNTS[currency] ?? SANDBOX_ORIGINATOR_BANK_ACCOUNT_FALLBACK;
}

interface BvnkConfig {
  auth: { authId: string; secretKey: string };
  walletId: string;
  apiBaseUrl: string;
  signingHost: string;
  proxyAuthSecret?: string;
}

function readBvnkConfig(env: Record<string, string | undefined>, mode: SdpEnvironment): BvnkConfig {
  const authId = (
    mode === "sandbox" ? env.BVNK_SANDBOX_HAWK_AUTH_ID : env.BVNK_HAWK_AUTH_ID
  )?.trim();
  const secretKey = (
    mode === "sandbox" ? env.BVNK_SANDBOX_HAWK_SECRET_KEY : env.BVNK_HAWK_SECRET_KEY
  )?.trim();
  const walletId = (mode === "sandbox" ? env.BVNK_SANDBOX_WALLET_ID : env.BVNK_WALLET_ID)?.trim();

  if (!walletId || !authId || !secretKey) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "BVNK sandbox is not configured. Set BVNK_SANDBOX_WALLET_ID, BVNK_SANDBOX_HAWK_AUTH_ID, and BVNK_SANDBOX_HAWK_SECRET_KEY."
        : "BVNK is not configured. Set BVNK_WALLET_ID, BVNK_HAWK_AUTH_ID, and BVNK_HAWK_SECRET_KEY."
    );
  }

  const apiBaseUrlOverride = env.BVNK_API_BASE_URL?.trim();
  const apiBaseUrl =
    apiBaseUrlOverride || (mode === "sandbox" ? BVNK_SANDBOX_API_URL : BVNK_PRODUCTION_API_URL);
  try {
    new URL(apiBaseUrl);
  } catch {
    throw new SdpPaymentsError("INTERNAL_ERROR", "BVNK API URL configuration is invalid.");
  }

  const signingHostInput =
    env.BVNK_SIGNING_HOST?.trim() ||
    (mode === "sandbox" ? BVNK_SANDBOX_API_URL : BVNK_PRODUCTION_API_URL);
  const signingHost = new URL(
    signingHostInput.includes("://") ? signingHostInput : `https://${signingHostInput}`
  ).hostname;

  const proxyAuthSecret = apiBaseUrlOverride
    ? env.PROXY_SHARED_SECRET?.trim() || undefined
    : undefined;

  return { auth: { authId, secretKey }, walletId, apiBaseUrl, signingHost, proxyAuthSecret };
}

function buildBvnkComplianceDetails(
  input?: BvnkComplianceInput,
  options?: { requirePartyDetails?: boolean }
): { partyDetails: Record<string, unknown>[] } {
  const partyDetails = Array.isArray(input?.partyDetails)
    ? input.partyDetails.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry)
      )
    : [];

  if (options?.requirePartyDetails && partyDetails.length === 0) {
    throw new SdpPaymentsError(
      "BAD_REQUEST",
      "bvnkCompliance.partyDetails is required for BVNK off-ramp requests."
    );
  }

  return { partyDetails };
}

async function buildBvnkHawkAuthorizationHeader(
  url: URL,
  method: ProviderRequestInit<unknown>["method"],
  authId: string,
  secretKey: string,
  signingHost: string
): Promise<string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const resource = `${url.pathname}${url.search}`;

  const normalized = [
    "hawk.1.header",
    ts,
    nonce,
    method,
    resource,
    signingHost.toLowerCase(),
    "443",
    "",
    "",
    "",
  ].join("\n");

  const mac = await hmacSha256Base64(normalized, secretKey);
  return `Hawk id="${authId}", ts="${ts}", nonce="${nonce}", mac="${mac}"`;
}

/**
 * A CloudFront/WAF edge rejection returns a non-JSON HTML body ("Request blocked",
 * "Generated by cloudfront") rather than BVNK's JSON error envelope. This means the
 * request never reached BVNK's app, so it's an availability/rate-limit issue — not a
 * credential problem — and must not be reported as a Hawk misconfiguration.
 */
function isEdgeBlockBody(parsed: unknown, raw: string): boolean {
  if (parsed !== undefined) return false;
  return /cloudfront|request could not be satisfied|request blocked/i.test(raw);
}

/**
 * Normalizes a BVNK non-2xx status into an SdpPaymentsError. Auth failures point at our
 * Hawk credential configuration, rate limits surface as-is, and any 5xx is a
 * BVNK-side failure operators should investigate rather than a bad request body.
 */
function mapBvnkErrorStatus(
  status: number,
  message: string,
  options?: { edgeBlocked?: boolean; details?: Record<string, unknown> }
): SdpPaymentsError {
  if (options?.edgeBlocked) {
    return providerUnavailable(
      `BVNK request was blocked at the edge (CloudFront/WAF, status ${status}) before reaching the API. This is typically IP rate-limiting, not a credential issue; retry shortly or from a different egress.`
    );
  }
  if (status === 401) {
    return providerNotConfigured(
      "BVNK rejected the request credentials (status 401). Check the BVNK Hawk auth configuration."
    );
  }
  if (status === 403) {
    return providerNotConfigured(
      "BVNK request was forbidden (status 403). Check the BVNK Hawk auth/account permissions, and — when BVNK_API_BASE_URL routes through the egress proxy — the PROXY_SHARED_SECRET / X-Proxy-Auth configuration."
    );
  }
  if (status === 429) {
    return new SdpPaymentsError("RATE_LIMITED", message);
  }
  if (status >= 500) {
    return new SdpPaymentsError("INTERNAL_ERROR", `BVNK request failed with status ${status}.`);
  }
  return badRequest(message, options?.details);
}

const bvnkErrorEnvelopeSchema = z.object({
  details: z.object({ errors: z.unknown() }).optional(),
});

function parseBvnkValidationDetails(payload: unknown): Record<string, unknown> | undefined {
  const result = bvnkErrorEnvelopeSchema.safeParse(payload);
  if (!result.success || result.data.details === undefined) {
    return undefined;
  }
  return { errors: result.data.details.errors };
}

const bvnkChannelAddressSchema = z.object({
  network: z.string().optional(),
  address: z.string().optional(),
  uri: z.string().optional(),
});
const bvnkChannelResponseSchema = z.object({
  uuid: z.string().optional(),
  reference: z.string().optional(),
  status: z.string().optional(),
  address: z.string().optional(),
  network: z.string().optional(),
  alternatives: z.array(bvnkChannelAddressSchema).optional(),
});
type BvnkChannelAddress = z.infer<typeof bvnkChannelAddressSchema>;
type BvnkChannelResponse = z.infer<typeof bvnkChannelResponseSchema>;

/** Picks the deposit address for the requested network from the channel's primary slot or alternatives. */
function parseBvnkChannelAddress(channel: BvnkChannelResponse, network: BvnkNetwork): string {
  const candidates: BvnkChannelAddress[] = [{ network: channel.network, address: channel.address }];
  if (channel.alternatives) {
    candidates.push(...channel.alternatives);
  }
  const match = candidates.find(
    (candidate) => candidate.network?.toUpperCase() === network && candidate.address
  );
  if (!match?.address) {
    throw badRequest(`BVNK channel did not return a ${network} deposit address.`);
  }
  return match.address;
}

const bvnkPayoutEstimateResponseSchema = z.object({
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
type BvnkPayoutEstimateResponse = z.infer<typeof bvnkPayoutEstimateResponseSchema>;

const bvnkQuoteEstimateResponseSchema = z.object({
  amountIn: z.number(),
  amountOut: z.number(),
  acceptanceExpiryDate: z.number(),
  payInMethod: z.object({ settlementCurrency: z.string() }),
  fees: z.object({ value: z.object({ service: z.number(), processing: z.number() }) }),
});

function assertPositiveDecimalAmount(value: string, fieldName: string): string {
  if (!isDecimalString(value) || compareDecimalAmounts(value, "0") <= 0) {
    throw badRequest(`${fieldName} must be a positive amount`);
  }
  return value;
}

function parseBvnkEstimateFeeCurrency(value: string): PaymentRampEstimateFees["currency"] {
  const normalized = value.trim().toUpperCase();
  const fiat = bvnkEstimateFiatCurrencySchema.safeParse(normalized);
  if (fiat.success) {
    return fiat.data;
  }
  if (isSolanaCryptoAsset(normalized)) {
    return normalized;
  }
  throw new SdpPaymentsError(
    "PROVIDER_UNAVAILABLE",
    `Unsupported BVNK estimate fee currency: ${value}`
  );
}

function countDecimalPlaces(value: string): number {
  if (!isDecimalString(value)) {
    throw new SdpPaymentsError(
      "PROVIDER_UNAVAILABLE",
      "BVNK returned an invalid decimal estimate amount"
    );
  }
  const decimalIndex = value.indexOf(".");
  if (decimalIndex === -1) {
    return 0;
  }
  return value.length - decimalIndex - 1;
}

function subtractBvnkEstimateFees(estimate: BvnkPayoutEstimateResponse): string {
  const walletRequiredAmount = decimalStringFromNumber(estimate.walletRequiredAmount);
  const feePredictedAmount = decimalStringFromNumber(estimate.feePredictedAmount);
  const networkFeePredictedAmount = decimalStringFromNumber(estimate.networkFeePredictedAmount);
  const decimals = Math.max(
    countDecimalPlaces(walletRequiredAmount),
    countDecimalPlaces(feePredictedAmount),
    countDecimalPlaces(networkFeePredictedAmount)
  );
  const netAmount =
    parseDecimalAmount(walletRequiredAmount, decimals) -
    parseDecimalAmount(feePredictedAmount, decimals) -
    parseDecimalAmount(networkFeePredictedAmount, decimals);
  if (netAmount < 0n) {
    throw new SdpPaymentsError(
      "PROVIDER_UNAVAILABLE",
      "BVNK returned estimate fees above the gross amount"
    );
  }
  return formatDecimalAmount(netAmount, decimals);
}

function formatBvnkEstimateFeeTotal(estimate: BvnkPayoutEstimateResponse): string {
  const feePredictedAmount = decimalStringFromNumber(estimate.feePredictedAmount);
  const networkFeePredictedAmount = decimalStringFromNumber(estimate.networkFeePredictedAmount);
  const decimals = Math.max(
    countDecimalPlaces(feePredictedAmount),
    countDecimalPlaces(networkFeePredictedAmount)
  );
  const totalFee =
    parseDecimalAmount(feePredictedAmount, decimals) +
    parseDecimalAmount(networkFeePredictedAmount, decimals);
  return formatDecimalAmount(totalFee, decimals);
}

function formatBvnkNetExchangeRate(netFiatAmount: string, paidRequiredAmount: number): string {
  if (paidRequiredAmount <= 0) {
    throw new SdpPaymentsError("PROVIDER_UNAVAILABLE", "BVNK returned a non-positive paid amount");
  }
  return divideDecimalAmounts(netFiatAmount, decimalStringFromNumber(paidRequiredAmount));
}

const bvnkCurrencyEntrySchema = z.object({
  code: z.string().optional(),
  fiat: z.boolean().optional(),
  supportsDeposits: z.boolean().optional(),
  supportsWithdrawals: z.boolean().optional(),
  protocols: z.array(z.object({ networkCode: z.string().optional() })).optional(),
});

function addBvnkFiatCurrency(
  target: Record<string, RampCurrencyLimit>,
  code: string,
  droppedCodes: Set<string>
): void {
  const normalized = code.trim().toUpperCase();
  if (!isActiveIso4217CurrencyCode(normalized)) {
    droppedCodes.add(normalized);
    return;
  }
  target[normalized] = unreportedCurrencyLimit();
}

export function distillBvnkRailSupport(
  depositRaw: unknown,
  fiatRaw: unknown,
  cryptoRaw: unknown
): ProviderRailSupportDistillation {
  const depositList = z.array(bvnkCurrencyEntrySchema).parse(depositRaw);
  const fiatList = z.array(bvnkCurrencyEntrySchema).parse(fiatRaw);
  const cryptoList = z.array(bvnkCurrencyEntrySchema).parse(cryptoRaw);
  const droppedCodes = new Set<string>();
  const onrampCurrencies: Record<string, RampCurrencyLimit> = {};
  const offrampCurrencies: Record<string, RampCurrencyLimit> = {};
  const onrampCryptos = new Set<CryptoRailId>();
  const offrampCryptos = new Set<CryptoRailId>();

  for (const entry of depositList) {
    if (entry.fiat !== true) {
      continue;
    }
    if (entry.supportsDeposits !== true) {
      continue;
    }
    if (entry.code === undefined) {
      continue;
    }
    addBvnkFiatCurrency(onrampCurrencies, entry.code, droppedCodes);
  }

  for (const entry of fiatList) {
    if (entry.supportsWithdrawals !== true) {
      continue;
    }
    if (entry.code === undefined) {
      continue;
    }
    addBvnkFiatCurrency(offrampCurrencies, entry.code, droppedCodes);
  }

  for (const entry of cryptoList) {
    if (entry.code === undefined) {
      continue;
    }
    const upper = entry.code.toUpperCase();
    if (!isSolanaCryptoAsset(upper)) {
      continue;
    }
    if (entry.protocols === undefined) {
      continue;
    }
    const hasSolana = entry.protocols.some((protocol) => protocol.networkCode === "SOLANA");
    if (!hasSolana) {
      continue;
    }
    const rail = SOLANA_ASSET_TO_RAIL[upper];
    if (entry.supportsWithdrawals === true) {
      onrampCryptos.add(rail);
    }
    if (entry.supportsDeposits === true) {
      offrampCryptos.add(rail);
    }
  }

  return {
    snapshot: {
      onramp: {
        currencies: onrampCurrencies,
        cryptos: [...onrampCryptos].sort(),
      },
      offramp: {
        currencies: offrampCurrencies,
        cryptos: [...offrampCryptos].sort(),
      },
    },
    droppedCurrencyCodes: [...droppedCodes].sort(),
    droppedCountryCodes: [],
  };
}

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
export type BvnkCustomerV2Status = z.infer<typeof bvnkV2CustomerStatusSchema>;

const bvnkV2CustomerTypeSchema = z.enum(["COMPANY", "INDIVIDUAL"]);
const bvnkV2CustomerModelSchema = z.enum([
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
export type BvnkCustomerV2Address = z.infer<typeof bvnkV2AddressSchema>;

const bvnkV2TaxIdentificationSchema = z.object({
  number: z.string().min(1),
  taxResidenceCountryCode: z.string().min(2),
});

const bvnkV2EmploymentStatusSchema = z.enum(["SALARIED", "SELF_EMPLOYED", "UNEMPLOYED", "RETIRED"]);
export type BvnkCustomerV2EmploymentStatus = z.infer<typeof bvnkV2EmploymentStatusSchema>;

const bvnkV2SourceOfFundsSchema = z.enum([
  "SALARY",
  "PENSION",
  "SAVINGS",
  "SELF_EMPLOYMENT",
  "CRYPTO_TRADING",
  "GAMBLING",
  "REAL_ESTATE",
  "GIFT",
  "STUDENT_LOAN_GRANT",
]);
export type BvnkCustomerV2SourceOfFunds = z.infer<typeof bvnkV2SourceOfFundsSchema>;

const bvnkV2PepStatusSchema = z.enum([
  "NOT_PEP",
  "FORMER_PEP_2_YEARS",
  "FORMER_PEP_OLDER",
  "DOMESTIC_PEP",
  "FOREIGN_PEP",
  "CLOSE_ASSOCIATES",
  "FAMILY_MEMBERS",
  "STATE_OWNED",
]);
const bvnkV2IntendedUseOfAccountSchema = z.enum([
  "TRANSFERS_OWN_WALLET",
  "TRANSFERS_FAMILY_FRIENDS",
  "INVESTMENTS",
  "GOODS_SERVICES",
  "DONATIONS",
]);
export type BvnkCustomerV2IntendedUseOfAccount = z.infer<typeof bvnkV2IntendedUseOfAccountSchema>;

const bvnkV2IncomeSchema = z.enum([
  "INCOME_0_TO_50K",
  "INCOME_50K_TO_100K",
  "INCOME_100K_TO_250K",
  "INCOME_250K_TO_500K",
  "INCOME_500K_TO_750K",
  "INCOME_750K_TO_1M",
  "INCOME_ABOVE_1M",
]);
const bvnkV2IndustrySectorSchema = z.enum([
  "INVESTMENT",
  "HEDGE_FUND",
  "MONEY_SERVICE_BUSINESS",
  "STO_ISSUER",
  "PRECIOUS_METALS",
  "NON_PROFIT",
  "REGISTERED_INVESTMENT_ADVISOR",
  "AGRICULTURE_FORESTRY_FISHING_HUNTING",
  "MINING",
  "UTILITIES",
  "CONSTRUCTION",
  "MANUFACTURING",
  "WHOLESALE_TRADE",
  "RETAIL_TRADE",
  "TRANSPORTATION_WAREHOUSING",
  "INFORMATION",
  "FINANCE_INSURANCE",
  "REAL_ESTATE_RENTAL_LEASING",
  "PROFESSIONAL_SCIENTIFIC_TECHNICAL_SERVICES",
  "MANAGEMENT_OF_COMPANIES_ENTERPRISES",
  "ADMINISTRATIVE_SUPPORT_WASTE_MANAGEMENT_REMEDIATION_SERVICES",
  "EDUCATIONAL_SERVICES",
  "HEALTH_CARE_SOCIAL_ASSISTANCE",
  "ARTS_ENTERTAINMENT_RECREATION",
  "ACCOMMODATION_FOOD_SERVICES",
  "OTHER_SERVICES",
  "PUBLIC_ADMINISTRATION",
  "NOT_CLASSIFIED",
  "ADULT_ENTERTAINMENT",
  "AUCTIONS",
  "AUTOMOBILES",
  "BLOCKCHAIN",
  "CRYPTO",
  "DRUGS",
  "EXPORT_IMPORT",
  "E_COMMERCE",
  "FINANCIAL_INSTITUTION",
  "GAMBLING",
  "INSURANCE",
  "MARKET_MAKER",
  "SHELL_BANK",
  "TRAVEL_TRANSPORT",
  "WEAPONS",
]);

const bvnkV2ExpectedMonthlyVolumeSchema = z.object({
  amount: z.union([z.string().min(1), z.number().finite()]),
  currency: z.string().min(1),
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
  nationality: z.string().min(2).optional(),
  taxIdentification: bvnkV2TaxIdentificationSchema.optional(),
  cdd: bvnkV2CddSchema.optional(),
});
export type BvnkCustomerV2Individual = z.infer<typeof bvnkV2IndividualSchema>;

export type BvnkCustomerV2UseCase = z.infer<typeof bvnkV2CustomerUseCaseSchema>;

export interface CreateBvnkCustomerV2Input {
  idempotencyKey: string;
  useCase: BvnkCustomerV2UseCase;
  reference?: string;
  model?: "RELIANCE";
  individual: BvnkCustomerV2Individual;
}

const bvnkV3ContactSchema = z.object({ contactId: z.string().min(1) });
export type BvnkContactV3 = z.infer<typeof bvnkV3ContactSchema>;

export interface CreateBvnkContactV3Input {
  idempotencyKey: string;
  entity: {
    type: "INDIVIDUAL";
    relationshipType: "SELF_OWNED";
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    address: {
      addressLine1: string;
      city: string;
      region?: string;
      postalCode: string;
      country: string;
    };
  };
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
export type BvnkCustomerV2RequiredAction = z.infer<typeof bvnkV2RequiredActionSchema>;
const bvnkV2AuthenticatedLinkSchema = z.object({
  link: z.string().min(1),
  expiresAt: z.string().min(1),
});
const bvnkV2CustomerSummarySchema = z.object({
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
const bvnkV2CustomerDetailSchema = bvnkV2CustomerSummarySchema.extend({
  authenticatedLink: bvnkV2AuthenticatedLinkSchema,
  requiredActions: z.array(bvnkV2RequiredActionSchema),
  individual: bvnkV2IndividualSchema.optional(),
});
export type BvnkCustomerV2Detail = z.infer<typeof bvnkV2CustomerDetailSchema>;

const bvnkV2AgreementStatusSchema = z.enum(["PENDING", "ACCEPTED", "REJECTED"]);
const bvnkV2AgreementSchema = z.object({
  id: z.string().min(1),
  status: bvnkV2AgreementStatusSchema,
  declinable: z.boolean(),
  name: z.string().optional(),
  description: z.string().optional(),
});
const bvnkV2AgreementsResponseSchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1),
  agreements: z.array(bvnkV2AgreementSchema),
  signingUrl: z.string().min(1),
});
export type BvnkAgreementsV2 = z.infer<typeof bvnkV2AgreementsResponseSchema>;
const bvnkV2AgreementContentSchema = z.object({
  downloadUrl: z.string().min(1),
  expiresAt: z.string().nullable().optional(),
  filename: z.string().min(1),
});
export type BvnkAgreementContentV2 = z.infer<typeof bvnkV2AgreementContentSchema>;
const bvnkV2AgreementActionTypeSchema = z.enum(["ACCEPT", "REJECT"]);
export type BvnkAgreementActionTypeV2 = z.infer<typeof bvnkV2AgreementActionTypeSchema>;
export interface BvnkAgreementActionV2 {
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
const bvnkV2AgreementActionResultSchema = z.object({
  agreementId: z.string().min(1),
  status: z.enum(["ACCEPTED", "REJECTED"]).optional(),
  error: z.string().optional(),
});
const bvnkV2PageableSchema = z
  .object({ pageNumber: z.number().int(), pageSize: z.number().int() })
  .optional();
const bvnkV2AgreementActionResultsSchema = z.object({
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
const bvnkV2AssignedAgreementsSchema = z.object({
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
const bvnkV2WalletProfilesSchema = z.object({
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
export type BvnkLedgerWalletPaymentInstrumentV2 = z.infer<typeof bvnkV2PaymentInstrumentSchema>;
const bvnkV2LedgerWalletSchema = z.object({
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

const bvnkRuleResponseSchema = z.object({
  id: z.string().optional(),
  reference: z.string().optional(),
  status: z.string().optional(),
  originator: z
    .object({ currency: z.string().optional(), walletId: z.string().optional() })
    .optional(),
});
type BvnkRuleResponse = z.infer<typeof bvnkRuleResponseSchema>;

export class BvnkRampClient implements RampProvider {
  readonly id = "bvnk";
  readonly declaredRailSupport = BVNK_DECLARED_RAIL_SUPPORT;

  private async request(
    config: BvnkConfig,
    path: string,
    init: {
      method: ProviderRequestInit<unknown>["method"];
      body?: unknown;
      headers?: Record<string, string>;
    }
  ): Promise<unknown> {
    const url = new URL(path, config.apiBaseUrl);
    const authorization = await buildBvnkHawkAuthorizationHeader(
      url,
      init.method,
      config.auth.authId,
      config.auth.secretKey,
      config.signingHost
    );

    const { response, raw, parsed } = await providerFetch(this.id, url.toString(), {
      ...init,
      headers: {
        Authorization: authorization,
        ...(config.proxyAuthSecret ? { "X-Proxy-Auth": config.proxyAuthSecret } : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      const message = `BVNK request failed with status ${response.status}`;
      throw mapBvnkErrorStatus(response.status, message, {
        edgeBlocked: isEdgeBlockBody(parsed, raw),
        details: response.status === 400 ? parseBvnkValidationDetails(parsed) : undefined,
      });
    }

    if (parsed === undefined) {
      throw providerUnavailable("BVNK returned an unparseable response", {
        provider: this.id,
      });
    }
    return parsed;
  }

  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return validateBvnkCounterparty(counterparty, options);
  }

  async discoverCurrencyAndRails(
    context: RampDiscoveryContext
  ): Promise<ProviderRailSupportDistillation> {
    if (!context.offline) {
      const { env, fetchJson, writeDump } = context;
      const railsBaseOverride = env.BVNK_RAMP_RAILS_API_BASE_URL?.trim();
      const base = railsBaseOverride || "https://api.sandbox.bvnk.com/";
      const proxyAuthSecret = railsBaseOverride ? env.PROXY_SHARED_SECRET?.trim() : undefined;
      // biome-ignore lint/security/noSecrets: BVNK pagination query string, not a secret.
      const pageQuery = "?offset=0&max=1000";

      for (const request of [
        {
          path: `/api/currency/crypto${pageQuery}`,
          dumpName: RAMP_RAIL_DUMPS.bvnk.cryptoAnon.name,
        },
        {
          path: `/api/currency/fiat${pageQuery}`,
          dumpName: RAMP_RAIL_DUMPS.bvnk.fiatAnon.name,
        },
        {
          path: `/api/currency/deposit${pageQuery}`,
          dumpName: RAMP_RAIL_DUMPS.bvnk.depositAnon.name,
        },
      ]) {
        const url = new URL(request.path.replace(/^\//, ""), base);
        await writeDump(
          request.dumpName,
          await fetchJson(this.id, `anon ${request.path}`, url.toString(), {
            headers: {
              Accept: "application/json",
              ...(proxyAuthSecret ? { "X-Proxy-Auth": proxyAuthSecret } : {}),
            },
          })
        );
      }
    }
    const [deposit, fiat, crypto] = await Promise.all([
      context.readDump(RAMP_RAIL_DUMPS.bvnk.depositAnon.file),
      context.readDump(RAMP_RAIL_DUMPS.bvnk.fiatAnon.file),
      context.readDump(RAMP_RAIL_DUMPS.bvnk.cryptoAnon.file),
    ]);
    return distillBvnkRailSupport(deposit, fiat, crypto);
  }

  /**
   * Creates a v2 individual BVNK customer onboarding application.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Customer details and an idempotency key derived deterministically from canonical SDP ids.
   * @returns The newly created BVNK customer summary.
   */
  async createCustomerV2(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkCustomerV2Input
  ): Promise<BvnkCustomerV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v2/customers", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: {
        useCase: input.useCase,
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        ...(input.model === undefined ? {} : { model: input.model }),
        individual: input.individual,
      },
    });
    return bvnkV2CustomerSummarySchema.parse(response);
  }

  /**
   * Creates the BVNK v3 travel-rule contact for an individual customer.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Contact data and a deterministic idempotency key. The entity contains PII and is never logged.
   * @returns The BVNK contact identifier.
   */
  async createContactV3(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkContactV3Input
  ): Promise<BvnkContactV3> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v3/contacts", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: { entity: input.entity },
    });
    return bvnkV3ContactSchema.parse(response);
  }

  /**
   * Retrieves a v2 BVNK customer, including its current authenticated onboarding link.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - BVNK customer id.
   * @returns The typed customer detail response, including required actions and authenticated link.
   */
  async getCustomerV2(
    { env, mode }: RampRuntimeContext,
    input: { id: string }
  ): Promise<BvnkCustomerV2Detail> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/platform/v2/customers/${encodeURIComponent(input.id)}`,
      { method: "GET" }
    );
    return bvnkV2CustomerDetailSchema.parse(response);
  }

  /**
   * Creates a v2 agreement working set for a prospective BVNK customer.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Agreement working-set details and an idempotency key derived deterministically from canonical SDP ids.
   * @returns The created agreement working set and signing URL.
   */
  async createAgreementsV2(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkAgreementsV2Input
  ): Promise<BvnkAgreementsV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v2/agreements", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: {
        reference: input.reference,
        useCase: input.useCase,
        customerType: input.customerType,
        countryCode: input.countryCode,
      },
    });
    return bvnkV2AgreementsResponseSchema.parse(response);
  }

  /**
   * Retrieves a fresh presigned document URL for a v2 agreement.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Agreement id.
   * @returns The agreement download URL, filename, and optional expiry.
   */
  async getAgreementContentV2(
    { env, mode }: RampRuntimeContext,
    input: { id: string }
  ): Promise<BvnkAgreementContentV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/platform/v2/agreements/${encodeURIComponent(input.id)}/content`,
      { method: "GET" }
    );
    return bvnkV2AgreementContentSchema.parse(response);
  }

  /**
   * Accepts or rejects agreements in a v2 agreement working set.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Agreement actions and an idempotency key derived deterministically from canonical SDP ids.
   * @returns Per-agreement action results from BVNK.
   */
  async respondAgreementsV2(
    { env, mode }: RampRuntimeContext,
    input: RespondBvnkAgreementsV2Input
  ): Promise<BvnkAgreementActionResultsV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v2/agreements/actions", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: { reference: input.reference, actions: input.actions },
    });
    return bvnkV2AgreementActionResultsSchema.parse(response);
  }

  /**
   * Lists agreements assigned to a v2 BVNK customer.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - BVNK customer id.
   * @returns The paginated assigned-agreement response.
   */
  async listCustomerAgreementsV2(
    { env, mode }: RampRuntimeContext,
    input: { customerId: string }
  ): Promise<BvnkAssignedAgreementsV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/platform/v2/customers/${encodeURIComponent(input.customerId)}/agreements`,
      { method: "GET" }
    );
    return bvnkV2AssignedAgreementsSchema.parse(response);
  }

  /**
   * Creates a v2 ledger wallet.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Wallet details and an idempotency key derived deterministically from canonical SDP ids.
   * @returns The typed ledger wallet, including fiat payment instruments when present.
   */
  async createLedgerWalletV2(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkLedgerWalletV2Input
  ): Promise<BvnkLedgerWalletV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/ledger/v2/wallets", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: {
        currency: input.currency,
        name: input.name,
        ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      },
    });
    return bvnkV2LedgerWalletSchema.parse(response);
  }

  /**
   * Retrieves a v2 ledger wallet.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Wallet id.
   * @returns The typed ledger wallet, including fiat payment instruments when present.
   */
  async getLedgerWalletV2(
    { env, mode }: RampRuntimeContext,
    input: { walletId: string }
  ): Promise<BvnkLedgerWalletV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/ledger/v2/wallets/${encodeURIComponent(input.walletId)}`,
      { method: "GET" }
    );
    return bvnkV2LedgerWalletSchema.parse(response);
  }

  /**
   * Lists v2 ledger wallet profiles and their supported payment rails.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Optional customer and currency filters.
   * @returns The paginated wallet-profile response.
   */
  async listLedgerWalletProfilesV2(
    { env, mode }: RampRuntimeContext,
    input?: ListBvnkLedgerWalletProfilesV2Input
  ): Promise<BvnkLedgerWalletProfilesV2> {
    const config = readBvnkConfig(env, mode);
    const filters = [
      input?.customerId === undefined ? undefined : `customerId:${input.customerId}`,
      input?.currency === undefined ? undefined : `currency:${input.currency}`,
    ].filter((filter): filter is string => filter !== undefined);
    const path =
      filters.length === 0
        ? "/ledger/v2/wallets/profiles"
        : `/ledger/v2/wallets/profiles?q=${encodeURIComponent(filters.join(" AND "))}`;
    const response = await this.request(config, path, { method: "GET" });
    return bvnkV2WalletProfilesSchema.parse(response);
  }

  async createOnrampRule(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkOnrampRuleInput
  ): Promise<BvnkRuleResponse> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/payment/v1/rules", {
      method: "POST",
      body: {
        reference: input.reference,
        trigger: "payment:payin:fiat",
        walletId: input.walletId,
        beneficiary: {
          currency: input.currency,
          entity: input.entity,
          cryptoAddress: { network: input.network, address: input.beneficiaryAddress },
        },
      },
    });
    return bvnkRuleResponseSchema.parse(response);
  }

  async simulatePayin(
    { env, mode }: RampRuntimeContext,
    input: {
      walletId: string;
      amount: number;
      currency: string;
      originatorName: string;
      remittanceInformation?: string;
    }
  ): Promise<unknown> {
    const config = readBvnkConfig(env, mode);
    const remittanceInformation =
      input.remittanceInformation ?? `SDP ${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    return this.request(config, "/payment/v2/payins/simulation", {
      method: "POST",
      body: {
        walletId: input.walletId,
        amount: input.amount,
        currency: input.currency,
        remittanceInformation,
        originator: {
          name: input.originatorName,
          bankAccount: sandboxOriginatorBankAccount(input.currency),
        },
      },
    });
  }

  async estimateOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const config = readBvnkConfig(env, mode);
    const { currency } = normalizeBvnkCurrencyAndNetwork(getCryptoRailAssetLabel(input.assetRail));
    const amountIn = assertPositiveDecimalAmount(input.fiatAmount, "fiatAmount");
    const quoteResponse = await this.request(config, "/api/v1/quote?estimate=true", {
      method: "POST",
      body: {
        from: input.fiatCurrency,
        to: currency,
        fromWalletLsid: config.walletId,
        toWalletLsid: config.walletId,
        amountIn: toNumberAmount(amountIn),
        useMinimum: false,
        useMaximum: false,
        payInMethod: "wallet",
        payOutMethod: "wallet",
      },
    });
    const quote = bvnkQuoteEstimateResponseSchema.parse(quoteResponse);
    if (quote.amountOut <= 0) {
      throw providerUnavailable("BVNK returned a non-positive converted amount");
    }
    const feeCurrency = parseBvnkEstimateFeeCurrency(quote.payInMethod.settlementCurrency);
    if (feeCurrency !== input.fiatCurrency) {
      throw providerUnavailable("BVNK returned on-ramp fees outside the fiat pay-in currency");
    }
    const fiatAmount = decimalStringFromNumber(quote.amountIn);
    const service = decimalStringFromNumber(quote.fees.value.service);
    const processing = decimalStringFromNumber(quote.fees.value.processing);
    const feeDecimals = Math.max(countDecimalPlaces(service), countDecimalPlaces(processing));
    const totalFee = formatDecimalAmount(
      parseDecimalAmount(service, feeDecimals) + parseDecimalAmount(processing, feeDecimals),
      feeDecimals
    );
    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount,
      cryptoAmount: decimalStringFromNumber(quote.amountOut),
      exchangeRate: formatBvnkNetExchangeRate(fiatAmount, quote.amountOut),
      fees: {
        currency: input.fiatCurrency,
        total: totalFee,
        provider: totalFee,
        providerCurrency: input.fiatCurrency,
      },
      expiresAt: new Date(quote.acceptanceExpiryDate).toISOString(),
    };
  }

  async estimateOfframp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    const config = readBvnkConfig(env, mode);
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(
      getCryptoRailAssetLabel(input.assetRail)
    );
    const paidRequiredAmount = assertPositiveDecimalAmount(input.cryptoAmount, "cryptoAmount");
    const estimateResponse = await this.request(config, "/api/v1/pay/estimate", {
      method: "POST",
      body: {
        walletId: config.walletId,
        walletCurrency: input.fiatCurrency,
        paidCurrency: currency,
        paidRequiredAmount: toNumberAmount(paidRequiredAmount),
        reference: rampId("sdp_offramp_est"),
        network,
      },
    });
    const estimate = bvnkPayoutEstimateResponseSchema.parse(estimateResponse);
    if (
      estimate.feePredictedAmount > 0 &&
      estimate.networkFeePredictedAmount > 0 &&
      estimate.feeCurrency !== estimate.networkFeeCurrency
    ) {
      throw new SdpPaymentsError(
        "PROVIDER_UNAVAILABLE",
        "BVNK returned fees in multiple currencies for this estimate"
      );
    }
    const feeCurrency = parseBvnkEstimateFeeCurrency(estimate.feeCurrency);
    const networkFeeCurrency = parseBvnkEstimateFeeCurrency(estimate.networkFeeCurrency);
    if (estimate.feePredictedAmount > 0 && feeCurrency !== input.fiatCurrency) {
      throw new SdpPaymentsError(
        "PROVIDER_UNAVAILABLE",
        "BVNK returned provider fees outside the fiat output currency"
      );
    }
    if (estimate.networkFeePredictedAmount > 0 && networkFeeCurrency !== input.fiatCurrency) {
      throw new SdpPaymentsError(
        "PROVIDER_UNAVAILABLE",
        "BVNK returned network fees outside the fiat output currency"
      );
    }
    const totalFeeCurrency = estimate.feePredictedAmount > 0 ? feeCurrency : networkFeeCurrency;
    const netFiatAmount = subtractBvnkEstimateFees(estimate);
    const totalFee = formatBvnkEstimateFeeTotal(estimate);
    return {
      provider: this.id,
      direction: "offramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: netFiatAmount,
      cryptoAmount: decimalStringFromNumber(estimate.paidRequiredAmount),
      exchangeRate: formatBvnkNetExchangeRate(netFiatAmount, estimate.paidRequiredAmount),
      fees: {
        currency: totalFeeCurrency,
        total: totalFee,
        provider: decimalStringFromNumber(estimate.feePredictedAmount),
        providerCurrency: feeCurrency,
        network: decimalStringFromNumber(estimate.networkFeePredictedAmount),
        networkCurrency: networkFeeCurrency,
      },
    };
  }

  async createOfframpQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    if (!input.fiatCurrency) {
      throw badRequest("fiatCurrency is required for BVNK off-ramp.");
    }
    if (!input.bvnkOfframpWalletId) {
      throw internalError("BVNK off-ramp requires a provisioned wallet id.");
    }
    const config = readBvnkConfig(env, mode);
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
    if (!isSolanaCryptoAsset(currency)) {
      throw internalError(`BVNK off-ramp returned unsupported SDP crypto asset: ${currency}`);
    }
    const fiatCurrency = input.fiatCurrency;
    if (!input.paymentTransferId) {
      throw internalError("BVNK off-ramp requires an SDP payment transfer id.");
    }
    const reference = buildBvnkOfframpReference(input.paymentTransferId);
    const complianceDetails = buildBvnkComplianceDetails(input.bvnkCompliance, {
      requirePartyDetails: true,
    });

    const channelResponse = await this.request(config, "/api/v2/channel", {
      method: "POST",
      body: {
        walletId: input.bvnkOfframpWalletId,
        payCurrency: currency,
        displayCurrency: fiatCurrency,
        reference,
        customerId: input.externalCustomerId,
        complianceDetails,
      },
    });
    const channel = bvnkChannelResponseSchema.parse(channelResponse);
    if (!channel.uuid) {
      throw badRequest("BVNK channel response is missing uuid");
    }
    const destinationAddress = assertValidAddress(
      parseBvnkChannelAddress(channel, network),
      "BVNK channel deposit address"
    );

    return {
      provider: "bvnk",
      id: channel.uuid,
      status: "pending",
      deliveryMode: "manual_instructions",
      paymentInstructions: [
        {
          provider: "bvnk",
          kind: "crypto_deposit",
          fiatCurrency,
          cryptoCurrency: currency,
          destinationAddress,
          network,
          reference,
          instructionsNotes: `Send ${currency} on ${network} to the deposit address. BVNK converts it to ${fiatCurrency} and pays out to the registered bank account.`,
        },
      ],
    };
  }
}
