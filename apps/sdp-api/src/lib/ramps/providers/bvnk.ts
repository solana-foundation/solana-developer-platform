import type {
  BvnkBankFundingDetails,
  BvnkOnboardingStatus,
  BvnkPaymentRampInstruction,
  Counterparty,
  CounterpartyEntityType,
  PaymentRampEstimate,
  PaymentRampEstimateFees,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp-support";
import { getCryptoRailAssetLabel, parseFiatCurrency } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@/lib/amount";
import {
  AppError,
  badRequest,
  internalError,
  providerNotConfigured,
  providerUnavailable,
} from "@/lib/errors";
import { hashString, hmacSha256Base64 } from "@/lib/hash";
import { readRecord, readString } from "@/lib/json";
import { assertValidAddress } from "@/lib/solana";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { type ProviderRequestInit, providerFetch } from "../fetch";
import { readyCounterparty } from "../requirements";
import {
  createProviderRampSupport,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  rampId,
  SOLANA_ASSET_TO_RAIL,
} from "../shared";
import type {
  ProviderRampSupport,
  RampDumpReader,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampProvider,
  RampRuntimeContext,
  RampWebhookValidationContext,
  RampWebhookValidationResult,
  ValidateCounterpartyOptions,
} from "../types";
import { bvnkCounterpartyRequirements } from "../validation/bvnk";

const BVNK_PRODUCTION_API_URL = "https://api.bvnk.com";
const BVNK_SANDBOX_API_URL = "https://api.sandbox.bvnk.com";
const bvnkEstimateFiatCurrencySchema = z.enum(RAMP_FIAT_CURRENCIES);

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

export interface BvnkRuleEntityAddress {
  addressLine1: string;
  addressLine2?: string;
  postalCode?: string;
  city: string;
  countryCode: string;
  /** ISO 3166-1 alpha-2 country; BVNK rule validation rejects a blank `country`. */
  country: string;
  /** ISO 3166-2 region/state code; BVNK requires it for US beneficiaries. */
  stateCode?: string;
}

type BvnkEntityType = "INDIVIDUAL" | "COMPANY";

const BVNK_ENTITY_TYPE = {
  individual: "INDIVIDUAL",
  business: "COMPANY",
} as const satisfies Record<CounterpartyEntityType, BvnkEntityType>;

/**
 * Beneficiary entity for a BVNK on-ramp payment rule. The handler builds this
 * from the counterparty identity; the provider only serializes it.
 */
export interface BvnkRuleEntity {
  type: BvnkEntityType;
  customerIdentifier: string;
  relationshipType: "SELF_OWNED" | "THIRD_PARTY";
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  legalName?: string;
  registrationNumber?: string;
  address?: BvnkRuleEntityAddress;
}

export interface BvnkComplianceInput {
  partyDetails?: Record<string, unknown>[];
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
    throw new AppError("INTERNAL_ERROR", "BVNK API URL configuration is invalid.");
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

const BVNK_NETWORKS = [
  "ALGORAND",
  "CARDANO",
  "BITCOIN_CASH",
  "BINANCE",
  "BITCOIN",
  "DOGECOIN",
  "ETHEREUM",
  "LITECOIN",
  "POLYGON",
  "SOLANA",
  "TRON",
  "RIPPLE",
] as const;

type BvnkNetwork = (typeof BVNK_NETWORKS)[number];

// Longest-first so suffix matching prefers the most specific network (e.g. BITCOIN_CASH before BITCOIN).
const BVNK_NETWORKS_BY_LENGTH_DESC = [...BVNK_NETWORKS].sort((a, b) => b.length - a.length);

const BVNK_NETWORK_ALIASES: Record<string, BvnkNetwork> = {
  algo: "ALGORAND",
  algorand: "ALGORAND",
  ada: "CARDANO",
  cardano: "CARDANO",
  bch: "BITCOIN_CASH",
  bitcoin_cash: "BITCOIN_CASH",
  bitcoincash: "BITCOIN_CASH",
  bnb: "BINANCE",
  binance: "BINANCE",
  btc: "BITCOIN",
  bitcoin: "BITCOIN",
  doge: "DOGECOIN",
  dogecoin: "DOGECOIN",
  eth: "ETHEREUM",
  ethereum: "ETHEREUM",
  ltc: "LITECOIN",
  litecoin: "LITECOIN",
  matic: "POLYGON",
  polygon: "POLYGON",
  sol: "SOLANA",
  solana: "SOLANA",
  tron: "TRON",
  trx: "TRON",
  xrp: "RIPPLE",
  ripple: "RIPPLE",
};

interface BvnkCurrencyNetwork {
  currency: string;
  network: BvnkNetwork;
}

export function normalizeBvnkCurrencyAndNetwork(value: string): BvnkCurrencyNetwork {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(normalized)) {
    throw badRequest("cryptoToken must be a valid BVNK currency code");
  }

  const tokenParts = normalized.split("_").filter((part) => part.length > 0);
  const currency = tokenParts[0];
  if (!currency) {
    throw badRequest("cryptoToken must include a BVNK currency code");
  }

  const networkHint = tokenParts.length > 1 ? tokenParts[tokenParts.length - 1]?.toLowerCase() : "";
  if (networkHint && BVNK_NETWORK_ALIASES[networkHint]) {
    return { currency, network: BVNK_NETWORK_ALIASES[networkHint] };
  }
  if (currency === "BTC") return { currency, network: "BITCOIN" };
  if (currency === "ETH") return { currency, network: "ETHEREUM" };
  if (currency === "SOL" || currency === "USDC" || currency === "USDT") {
    return { currency, network: "SOLANA" };
  }

  throw badRequest(
    `Unsupported BVNK cryptoToken '${value}'. Provide token with network (for example: BTC, ETH, SOL, USDC_SOLANA).`
  );
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
    throw new AppError(
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
 * Normalizes a BVNK non-2xx status into an AppError. Auth failures point at our
 * Hawk credential configuration, rate limits surface as-is, and any 5xx is a
 * BVNK-side failure operators should investigate rather than a bad request body.
 */
function mapBvnkErrorStatus(
  status: number,
  message: string,
  options?: { edgeBlocked?: boolean }
): AppError {
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
    return new AppError("RATE_LIMITED", message);
  }
  if (status >= 500) {
    return new AppError("INTERNAL_ERROR", `BVNK request failed with status ${status}.`);
  }
  return badRequest(message);
}

interface BvnkChannelAddress {
  network?: string;
  address?: string;
  uri?: string;
}

interface BvnkChannelResponse {
  uuid?: string;
  reference?: string;
  status?: string;
  address?: string;
  network?: string;
  redirectUrl?: string;
  alternatives?: BvnkChannelAddress[];
}

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

interface BvnkPayoutEstimateResponse {
  walletCurrency: string;
  walletRequiredAmount: number;
  paidCurrency: string;
  paidRequiredAmount: number;
  feeCurrency: string;
  feePredictedAmount: number;
  networkFeeCurrency: string;
  networkFeePredictedAmount: number;
  totalWalletAmount: number;
  exchangeRate: number;
}

interface BvnkQuoteEstimateResponse {
  amountIn: number;
  amountOut: number;
  acceptanceExpiryDate: number;
  payInMethod: { settlementCurrency: string };
  fees: { value: { service: number; processing: number } };
}

interface BvnkRuleResponse {
  id?: string;
  reference?: string;
  status?: string;
  originator?: { currency?: string; walletId?: string };
}

function toPositiveAmount(value: string, fieldName: string): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw badRequest(`${fieldName} must be a positive amount`);
  }
  return amount;
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
  throw new AppError("PROVIDER_UNAVAILABLE", `Unsupported BVNK estimate fee currency: ${value}`);
}

function countDecimalPlaces(value: string): number {
  if (!isDecimalString(value)) {
    throw new AppError("PROVIDER_UNAVAILABLE", "BVNK returned an invalid decimal estimate amount");
  }
  const decimalIndex = value.indexOf(".");
  if (decimalIndex === -1) {
    return 0;
  }
  return value.length - decimalIndex - 1;
}

function subtractBvnkEstimateFees(estimate: BvnkPayoutEstimateResponse): string {
  const walletRequiredAmount = String(estimate.walletRequiredAmount);
  const feePredictedAmount = String(estimate.feePredictedAmount);
  const networkFeePredictedAmount = String(estimate.networkFeePredictedAmount);
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
    throw new AppError(
      "PROVIDER_UNAVAILABLE",
      "BVNK returned estimate fees above the gross amount"
    );
  }
  return formatDecimalAmount(netAmount, decimals);
}

function formatBvnkEstimateFeeTotal(estimate: BvnkPayoutEstimateResponse): string {
  const feePredictedAmount = String(estimate.feePredictedAmount);
  const networkFeePredictedAmount = String(estimate.networkFeePredictedAmount);
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
    throw new AppError("PROVIDER_UNAVAILABLE", "BVNK returned a non-positive paid amount");
  }
  return String(Number(netFiatAmount) / paidRequiredAmount);
}

interface BvnkCurrencyEntry {
  code?: string;
  fiat?: boolean;
  supportsDeposits?: boolean;
  supportsWithdrawals?: boolean;
  protocols?: Array<{ networkCode?: string }>;
}

function extractSupport(
  depositList: readonly BvnkCurrencyEntry[],
  fiatList: readonly BvnkCurrencyEntry[],
  cryptoList: readonly BvnkCurrencyEntry[]
): ProviderRampSupport {
  const support = createProviderRampSupport();

  for (const entry of depositList) {
    if (entry.fiat !== true) continue;
    if (entry.supportsDeposits !== true) continue;
    if (!entry.code) continue;
    const parsed = parseFiatCurrency(entry.code);
    if (parsed) support.onrampFiats.add(parsed);
    else console.warn(`  [bvnk] unknown fiat code: ${entry.code}`);
  }

  for (const entry of fiatList) {
    if (entry.supportsWithdrawals !== true) continue;
    if (!entry.code) continue;
    const parsed = parseFiatCurrency(entry.code);
    if (parsed) support.offrampFiats.add(parsed);
    else console.warn(`  [bvnk] unknown fiat code: ${entry.code}`);
  }

  for (const entry of cryptoList) {
    if (!entry.code) continue;
    const upper = entry.code.toUpperCase();
    if (!isSolanaCryptoAsset(upper)) continue;
    const hasSolana = (entry.protocols ?? []).some((p) => p.networkCode === "SOLANA");
    if (!hasSolana) continue;
    const rail = SOLANA_ASSET_TO_RAIL[upper];
    if (entry.supportsWithdrawals === true) support.onrampCryptos.add(rail);
    if (entry.supportsDeposits === true) support.offrampCryptos.add(rail);
  }

  return support;
}

export interface BvnkAgreement {
  name?: string;
  displayName?: string;
  url?: string;
  privacyPolicyUrl?: string;
}

export interface BvnkAgreementSession {
  reference: string;
  agreements: BvnkAgreement[];
}

export type BvnkVerificationStatus = "init" | "pending" | "completed" | "failed";

export interface BvnkCustomerState {
  reference: string;
  status: string;
  verificationStatus?: BvnkVerificationStatus;
  verificationUrl?: string;
}

export interface BvnkFiatWallet {
  id: string;
  name?: string;
  status?: string;
  bankAccount?: BvnkBankFundingDetails;
}

export interface CreateBvnkAgreementSessionInput {
  customerType: BvnkEntityType;
  countryCode: string;
  useCase: string;
}

export interface CreateBvnkCustomerInput {
  /**
   * BVNK API field for the caller's stable customer identifier.
   * SDP sets this to a compact `cp_<uuid_without_hyphens>` alias via
   * `buildBvnkCustomerExternalReference`, because BVNK caps this field at 36
   * characters. Webhooks reverse it back to the canonical SDP counterparty id
   * without scanning provider_data.
   */
  externalReference: string;
  signedAgreementSessionReference: string;
  individual: Record<string, unknown>;
}

export interface CreateBvnkFiatWalletInput {
  /** Omit to create a merchant-owned wallet (BVNK off-ramp dedicated wallet). */
  customerReference?: string;
  name: string;
  currencyCode: string;
  walletProfile: string;
  idempotencyKey: string;
}

/**
 * Builds BVNK's `Idempotency-Key` header for fiat wallet creation.
 *
 * SDP's BVNK wallet `name` is the canonical wallet identity. BVNK caps
 * idempotency keys at 36 characters, so SDP hashes the full wallet name and
 * trims the digest to the provider limit instead of sending the long readable
 * name as the key.
 *
 * @param walletName BVNK wallet `name` generated by SDP.
 * @returns A stable 36-character idempotency key for the wallet name.
 */
export async function buildBvnkWalletIdempotencyKey(walletName: string): Promise<string> {
  return (await hashString(walletName)).slice(0, 36);
}

interface BvnkWalletProfile {
  id: string;
  currencies: string[];
  methods: string[];
}

function parseBvnkWalletProfileId(payload: unknown, currency: string): string | undefined {
  const content = readRecord(payload)?.content;
  if (!Array.isArray(content)) return undefined;
  const profiles = content.map((entry): BvnkWalletProfile => {
    const profile = readRecord(entry) ?? {};
    return {
      id: readString(profile.id) ?? "",
      currencies: Array.isArray(profile.currencies)
        ? profile.currencies.filter((c): c is string => typeof c === "string")
        : [],
      methods: Array.isArray(profile.methods)
        ? profile.methods.filter((m): m is string => typeof m === "string")
        : [],
    };
  });
  const target = currency.toUpperCase();
  const match =
    profiles.find((p) => p.id && p.currencies.some((c) => c.toUpperCase() === target)) ??
    profiles.find((p) => p.id);
  return match?.id || undefined;
}

export type BvnkWebhookEvent =
  | {
      kind: "ledger:v2:wallet:status-change";
      customerReference?: string;
      walletId?: string;
      walletName?: string;
      walletStatus?: string;
      bankAccount?: BvnkBankFundingDetails;
    }
  | {
      kind: "bvnk:ledger:wallet:create";
      customerReference?: string;
      walletId?: string;
      walletName?: string;
      walletStatus?: string;
      bankAccount?: BvnkBankFundingDetails;
    }
  | {
      kind: "bvnk:customers:status-change";
      customerReference?: string;
      customerStatus?: string;
    }
  | {
      kind: "bvnk:platform:customer:update";
      customerReference?: string;
      verificationUrl?: string;
    }
  | {
      kind: "bvnk:payment:payin:status-change";
      customerReference?: string;
      walletId?: string;
      status?: string;
      amount?: string;
    }
  | {
      kind:
        | "bvnk:payment:channel:transaction-detected"
        | "bvnk:payment:channel:transaction-confirmed";
      transferId?: string;
      channelId?: string;
      transactionId?: string;
      transactionHash?: string;
      status?: string;
      paidCurrency?: string;
      paidAmount?: string;
      displayCurrency?: string;
      displayAmount?: string;
      walletCurrency?: string;
      walletAmount?: string;
      feeCurrency?: string;
      feeAmount?: string;
    }
  | { kind: "ignore"; event: string };

export interface CreateBvnkOnrampRuleInput {
  reference: string;
  walletId: string;
  currency: string;
  network: string;
  beneficiaryAddress: string;
  entity: BvnkRuleEntity;
}

function parseBvnkAgreementSession(payload: unknown): BvnkAgreementSession {
  const data = readRecord(payload) ?? {};
  const reference = readString(data.reference);
  if (!reference) {
    throw badRequest("BVNK agreement session response is missing a reference");
  }
  const agreements = Array.isArray(data.agreements)
    ? data.agreements.map((entry): BvnkAgreement => {
        const a = readRecord(entry) ?? {};
        return {
          name: readString(a.name),
          displayName: readString(a.displayName),
          url: readString(a.url),
          privacyPolicyUrl: readString(a.privacyPolicyUrl),
        };
      })
    : [];
  return { reference, agreements };
}

const BVNK_VERIFICATION_STATUSES = new Set<BvnkVerificationStatus>([
  "init",
  "pending",
  "completed",
  "failed",
]);

function parseBvnkVerificationStatus(value: unknown): BvnkVerificationStatus | undefined {
  const status = readString(value)?.toLowerCase();
  return status && BVNK_VERIFICATION_STATUSES.has(status as BvnkVerificationStatus)
    ? (status as BvnkVerificationStatus)
    : undefined;
}

const BVNK_VERIFIED_STATUSES = new Set(["VERIFIED", "COMPLETED", "APPROVED"]);
const BVNK_VERIFYING_STATUSES = new Set(["PENDING"]);
const BVNK_VERIFICATION_REQUIRED_STATUSES = new Set(["ACTIONS_REQUIRED", "INFO_REQUIRED"]);
const BVNK_VERIFICATION_FAILED_STATUSES = new Set(["REJECTED"]);

/**
 * Whether a cached BVNK customer status counts as fully verified. The customer
 * KYC enum's success state is VERIFIED, but webhook events also report terminal
 * success as COMPLETED/APPROVED — treat all as verified.
 */
export function isBvnkCustomerVerified(status: string | undefined): boolean {
  return status !== undefined && BVNK_VERIFIED_STATUSES.has(status.toUpperCase());
}

/**
 * Onboarding phase for a not-yet-verified BVNK customer, decided from the KYC
 * status the customers:status-change webhook delivers — never from the presence
 * of a cached verificationUrl, which is written once and never cleared. PENDING
 * means the applicant has submitted and is under review; INFO_REQUIRED (and the
 * ACTIONS_REQUIRED synonym) mean the applicant must still act, so we surface the
 * Sumsub URL; REJECTED is terminal-negative. Any other unverified status is
 * unmapped and throws so it surfaces loudly instead of silently stranding the
 * buyer mid-onboarding.
 */
export function bvnkUnverifiedOnboardingStatus(
  status: string | undefined
): Extract<BvnkOnboardingStatus, "verifying" | "verification_required" | "verification_failed"> {
  const normalized = status?.toUpperCase();
  if (normalized && BVNK_VERIFYING_STATUSES.has(normalized)) {
    return "verifying";
  }
  if (normalized && BVNK_VERIFICATION_REQUIRED_STATUSES.has(normalized)) {
    return "verification_required";
  }
  if (normalized && BVNK_VERIFICATION_FAILED_STATUSES.has(normalized)) {
    return "verification_failed";
  }
  throw internalError(`Unmapped BVNK customer KYC status: ${status ?? "(missing)"}`);
}

function parseBvnkCustomerState(payload: unknown): BvnkCustomerState {
  const data = readRecord(payload) ?? {};
  const reference = readString(data.reference);
  if (!reference) {
    throw badRequest("BVNK customer response is missing a reference");
  }
  const status = readString(data.status);
  if (!status) {
    throw badRequest("BVNK customer response is missing a status");
  }
  const verification = readRecord(data.verification) ?? {};
  return {
    reference,
    status,
    verificationStatus: parseBvnkVerificationStatus(verification.status),
    verificationUrl: readString(verification.url),
  };
}

function parseBvnkLedgersBankAccount(
  data: Record<string, unknown>
): BvnkBankFundingDetails | undefined {
  const ledgers = Array.isArray(data.ledgers) ? data.ledgers : [];
  for (const entry of ledgers) {
    const ledger = readRecord(entry) ?? {};
    const accountNumber = readString(ledger.accountNumber);
    if (accountNumber) {
      return {
        accountNumber,
        code: readString(ledger.code),
        accountNumberFormat: readString(ledger.accountNumberFormat),
      };
    }
  }
  return undefined;
}

function parseBvnkFiatWallet(payload: unknown): BvnkFiatWallet {
  const data = readRecord(payload) ?? {};
  const id = readString(data.id);
  if (!id) {
    throw badRequest("BVNK wallet response is missing an id");
  }
  const name = readString(data.name);
  const status = readString(data.status);
  const instruments = Array.isArray(data.paymentInstruments) ? data.paymentInstruments : [];
  for (const entry of instruments) {
    const inst = readRecord(entry) ?? {};
    if (readString(inst.type) !== "FIAT") continue;
    const bank = readRecord(inst.bankDetails) ?? {};
    return {
      id,
      name,
      status,
      bankAccount: {
        accountNumber: readString(inst.accountNumber),
        code: readString(bank.bic),
        paymentReference: readString(inst.remittanceInformationPrefix),
        bankName: readString(bank.name),
      },
    };
  }
  return { id, name, status };
}

function readBvnkAmount(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}

export class BvnkRampClient implements RampProvider {
  readonly id = "bvnk";

  private async request<T = unknown>(
    config: BvnkConfig,
    path: string,
    init: {
      method: ProviderRequestInit<unknown>["method"];
      body?: unknown;
      headers?: Record<string, string>;
    }
  ): Promise<T> {
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
      console.warn(`[bvnk] ${init.method} ${path} -> ${response.status}: ${raw.slice(0, 600)}`);
      const message = raw.trim() || `BVNK request failed with status ${response.status}`;
      throw mapBvnkErrorStatus(response.status, message, {
        edgeBlocked: isEdgeBlockBody(parsed, raw),
      });
    }

    return (parsed ?? {}) as T;
  }

  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return bvnkCounterpartyRequirements(counterparty, options);
  }

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProvider["_discoverRails"]>[0]) {
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

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(
      await readDump<readonly BvnkCurrencyEntry[]>(RAMP_RAIL_DUMPS.bvnk.depositAnon.file),
      await readDump<readonly BvnkCurrencyEntry[]>(RAMP_RAIL_DUMPS.bvnk.fiatAnon.file),
      await readDump<readonly BvnkCurrencyEntry[]>(RAMP_RAIL_DUMPS.bvnk.cryptoAnon.file)
    );
  }

  async validateWebhook({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<RampWebhookValidationResult> {
    const secret = (
      environment === "sandbox" ? env.BVNK_SANDBOX_WEBHOOK_SECRET : env.BVNK_WEBHOOK_SECRET
    )?.trim();
    if (!secret) {
      throw providerNotConfigured(
        environment === "sandbox"
          ? "BVNK sandbox webhook secret is not configured (BVNK_SANDBOX_WEBHOOK_SECRET)."
          : "BVNK webhook secret is not configured (BVNK_WEBHOOK_SECRET)."
      );
    }
    const signature = headers.get("x-signature")?.trim();
    if (!signature) {
      throw new AppError("UNAUTHORIZED", "BVNK webhook is missing the X-Signature header", {
        provider: this.id,
      });
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw badRequest("BVNK webhook body must be valid JSON", {
        provider: this.id,
      });
    }
    const timestamp = payload.timestamp;
    await verifyWebhookSignature({
      provider: this.id,
      signedPayload: rawBody,
      signature,
      algorithm: { type: "hmac-sha256", secret, encoding: "base64" },
      timestampSeconds: typeof timestamp === "string" ? Date.parse(timestamp) / 1000 : Number.NaN,
    });
    return { provider: this.id, payload };
  }

  /**
   * Maps a BVNK webhook to a typed event by its upstream `event` discriminator.
   * Each event carries the customer in a different field and a different
   * `status` (customer KYC vs wallet lifecycle), so they're mapped explicitly
   * rather than scraped generically.
   */
  parseBvnkWebhookEvent(payload: unknown): BvnkWebhookEvent {
    const root = readRecord(payload);
    const event = readString(root?.event);
    if (!event) {
      throw internalError("BVNK webhook is missing an event");
    }
    const data = readRecord(root?.data);
    if (!data) {
      throw internalError(`BVNK webhook "${event}" is missing a data object`);
    }

    switch (event) {
      case "bvnk:customers:status-change":
        return {
          kind: event,
          customerReference: readString(data.customerId),
          customerStatus: readString(data.status),
        };
      case "bvnk:platform:customer:update":
        return {
          kind: event,
          customerReference: readString(data.reference),
          verificationUrl: readString(readRecord(data.verification)?.url),
        };
      case "ledger:v2:wallet:status-change": {
        const wallet = parseBvnkFiatWallet(data);
        return {
          kind: event,
          customerReference: readString(readRecord(data.customer)?.id),
          walletId: wallet.id,
          walletName: wallet.name,
          walletStatus: readString(data.status),
          bankAccount: wallet.bankAccount,
        };
      }
      case "bvnk:ledger:wallet:create":
        return {
          kind: event,
          customerReference: readString(data.customerReference),
          walletId: readString(data.id),
          walletName: readString(data.walletName),
          walletStatus: readString(data.status),
          bankAccount: parseBvnkLedgersBankAccount(data),
        };
      case "bvnk:payment:payin:status-change":
        return {
          kind: event,
          customerReference: readString(data.customerReference),
          walletId: readString(readRecord(data.beneficiary)?.walletId),
          status: readString(data.status),
          amount: readBvnkAmount(readRecord(data.amount)?.value),
        };
      case "bvnk:payment:channel:transaction-detected":
      case "bvnk:payment:channel:transaction-confirmed": {
        const reference = readString(data.reference);
        return {
          kind: event,
          transferId: reference ? parseBvnkOfframpReference(reference) : undefined,
          channelId: readString(data.channelId),
          transactionId: readString(data.uuid),
          transactionHash: readString(data.hash),
          status: readString(data.status),
          paidCurrency: readString(data.paidCurrency),
          paidAmount: readBvnkAmount(data.paidAmount),
          displayCurrency: readString(data.displayCurrency),
          displayAmount: readBvnkAmount(data.displayAmount),
          walletCurrency: readString(data.walletCurrency),
          walletAmount: readBvnkAmount(data.walletAmount),
          feeCurrency: readString(data.feeCurrency),
          feeAmount: readBvnkAmount(data.feeAmount),
        };
      }
      default:
        return { kind: "ignore", event };
    }
  }

  async createAgreementSession(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkAgreementSessionInput
  ): Promise<BvnkAgreementSession> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v1/customers/agreement/sessions", {
      method: "POST",
      body: {
        customerType: input.customerType,
        countryCode: input.countryCode,
        useCase: input.useCase,
      },
    });
    return parseBvnkAgreementSession(response);
  }

  async signAgreement(
    { env, mode }: RampRuntimeContext,
    input: { reference: string; ipAddress: string }
  ): Promise<void> {
    const config = readBvnkConfig(env, mode);
    await this.request(
      config,
      `/platform/v1/customers/agreement/sessions/${encodeURIComponent(input.reference)}`,
      { method: "PUT", body: { status: "SIGNED", ipAddress: input.ipAddress } }
    );
  }

  async createBvnkCustomer(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkCustomerInput
  ): Promise<BvnkCustomerState> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v1/customers", {
      method: "POST",
      body: {
        type: "individual",
        externalReference: input.externalReference,
        signedAgreementSessionReference: input.signedAgreementSessionReference,
        individual: input.individual,
      },
    });
    return parseBvnkCustomerState(response);
  }

  async getBvnkCustomer(
    { env, mode }: RampRuntimeContext,
    input: { reference: string }
  ): Promise<BvnkCustomerState> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/platform/v1/customers/${encodeURIComponent(input.reference)}`,
      { method: "GET" }
    );
    return parseBvnkCustomerState(response);
  }

  /**
   * Resolves the BVNK wallet profile id available to a customer for a currency.
   * Profiles are per-customer (v2 beta endpoint).
   */
  async getFiatWalletProfile(
    { env, mode }: RampRuntimeContext,
    input: { customerReference?: string; currency: string }
  ): Promise<string> {
    const config = readBvnkConfig(env, mode);
    const query = input.customerReference
      ? `customerId:${input.customerReference} AND currency:${input.currency}`
      : `currency:${input.currency}`;
    const response = await this.request(
      config,
      `/ledger/v2/wallets/profiles?q=${encodeURIComponent(query)}`,
      { method: "GET" }
    );
    const profileId = parseBvnkWalletProfileId(response, input.currency);
    if (!profileId) {
      throw new AppError(
        "PROVIDER_UNAVAILABLE",
        `No BVNK ${input.currency} wallet profile is available for this customer.`
      );
    }
    return profileId;
  }

  async getFiatWallet(
    { env, mode }: RampRuntimeContext,
    input: { walletId: string }
  ): Promise<BvnkFiatWallet> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/ledger/v2/wallets/${encodeURIComponent(input.walletId)}`,
      { method: "GET" }
    );
    return parseBvnkFiatWallet(response);
  }

  async createFiatWallet(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkFiatWalletInput
  ): Promise<BvnkFiatWallet> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/ledger/v2/wallets", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: {
        ...(input.customerReference ? { customerId: input.customerReference } : {}),
        currency: input.currencyCode,
        name: input.name,
        profileId: input.walletProfile,
      },
    });
    return parseBvnkFiatWallet(response);
  }

  async createOnrampRule(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkOnrampRuleInput
  ): Promise<BvnkRuleResponse> {
    const config = readBvnkConfig(env, mode);
    return this.request<BvnkRuleResponse>(config, "/payment/v1/rules", {
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
    const amountIn = toPositiveAmount(input.fiatAmount, "fiatAmount");
    const quote = await this.request<BvnkQuoteEstimateResponse>(
      config,
      "/api/v1/quote?estimate=true",
      {
        method: "POST",
        body: {
          from: input.fiatCurrency,
          to: currency,
          fromWalletLsid: config.walletId,
          toWalletLsid: config.walletId,
          amountIn,
          useMinimum: false,
          useMaximum: false,
          payInMethod: "wallet",
          payOutMethod: "wallet",
        },
      }
    );
    if (quote.amountOut <= 0) {
      throw providerUnavailable("BVNK returned a non-positive converted amount");
    }
    const feeCurrency = parseBvnkEstimateFeeCurrency(quote.payInMethod.settlementCurrency);
    if (feeCurrency !== input.fiatCurrency) {
      throw providerUnavailable("BVNK returned on-ramp fees outside the fiat pay-in currency");
    }
    const fiatAmount = String(quote.amountIn);
    const service = String(quote.fees.value.service);
    const processing = String(quote.fees.value.processing);
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
      cryptoAmount: String(quote.amountOut),
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
    const paidRequiredAmount = toPositiveAmount(input.cryptoAmount, "cryptoAmount");
    const estimate = await this.request<BvnkPayoutEstimateResponse>(
      config,
      "/api/v1/pay/estimate",
      {
        method: "POST",
        body: {
          walletId: config.walletId,
          walletCurrency: input.fiatCurrency,
          paidCurrency: currency,
          paidRequiredAmount,
          reference: rampId("sdp_offramp_est"),
          network,
        },
      }
    );
    if (
      estimate.feePredictedAmount > 0 &&
      estimate.networkFeePredictedAmount > 0 &&
      estimate.feeCurrency !== estimate.networkFeeCurrency
    ) {
      throw new AppError(
        "PROVIDER_UNAVAILABLE",
        "BVNK returned fees in multiple currencies for this estimate"
      );
    }
    const feeCurrency = parseBvnkEstimateFeeCurrency(estimate.feeCurrency);
    const networkFeeCurrency = parseBvnkEstimateFeeCurrency(estimate.networkFeeCurrency);
    if (estimate.feePredictedAmount > 0 && feeCurrency !== input.fiatCurrency) {
      throw new AppError(
        "PROVIDER_UNAVAILABLE",
        "BVNK returned provider fees outside the fiat output currency"
      );
    }
    if (estimate.networkFeePredictedAmount > 0 && networkFeeCurrency !== input.fiatCurrency) {
      throw new AppError(
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
      cryptoAmount: String(estimate.paidRequiredAmount),
      exchangeRate: formatBvnkNetExchangeRate(netFiatAmount, estimate.paidRequiredAmount),
      fees: {
        currency: totalFeeCurrency,
        total: totalFee,
        provider: String(estimate.feePredictedAmount),
        providerCurrency: feeCurrency,
        network: String(estimate.networkFeePredictedAmount),
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
    if (network !== "SOLANA") {
      throw internalError(`BVNK off-ramp returned unsupported SDP crypto network: ${network}`);
    }
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

    const channel = await this.request<BvnkChannelResponse>(config, "/api/v2/channel", {
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

/**
 * Builds the caller-defined BVNK off-ramp channel reference.
 *
 * The route pre-generates the SDP payment transfer id before creating the BVNK
 * channel, then persists the transfer with that same id after BVNK returns the
 * channel uuid. This keeps BVNK's human/provider-side reference tied to SDP's
 * transaction id.
 *
 * BVNK rejects `reference` values containing colons or other special
 * characters; allowed characters are alphanumeric characters, dashes,
 * underscores, and periods. This deliberately uses underscores instead of the
 * wallet-name convention (`sdp:offramp:...`) so the reference is accepted by
 * BVNK while still carrying SDP's transfer id.
 *
 * @param paymentTransferId SDP payment transfer id, for example `xfr_<uuid>`.
 * @returns BVNK off-ramp reference in `sdp_offramp_<transfer_id>` format.
 */
export function buildBvnkOfframpReference(paymentTransferId: string): string {
  if (!paymentTransferId.trim()) {
    throw internalError("BVNK off-ramp reference requires a payment transfer id.");
  }
  return `sdp_offramp_${paymentTransferId}`;
}

/**
 * Parses BVNK's channel transaction `data.reference` back into the SDP transfer id.
 *
 * @param reference BVNK off-ramp reference in `sdp_offramp_<transfer_id>` format.
 * @returns SDP payment transfer id, for example `xfr_<uuid>`.
 */
export function parseBvnkOfframpReference(reference: string): string {
  const prefix = "sdp_offramp_";
  if (!reference.startsWith(prefix)) {
    throw internalError(`Malformed BVNK off-ramp reference: ${reference}`);
  }
  const transferId = reference.slice(prefix.length);
  if (!/^xfr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transferId)) {
    throw internalError(`Malformed BVNK off-ramp reference: ${reference}`);
  }
  return transferId;
}

/** Shared, one-per-counterparty BVNK customer (KYC) state. */
export interface BvnkCustomerResolution {
  /**
   * BVNK customer `externalReference` value. For SDP-created customers this is
   * a reversible `cp_<uuid_without_hyphens>` alias for the SDP counterparty id,
   * sized to fit BVNK's 36-character limit.
   */
  externalReference?: string;
  customerReference?: string;
  status?: string;
  verificationStatus?: BvnkVerificationStatus;
  verificationUrl?: string;
}

const SDP_COUNTERPARTY_ID_PATTERN =
  /^counterparty_([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

/**
 * Builds the value stored in BVNK's customer `externalReference` field.
 *
 * BVNK limits `externalReference` to 36 characters, while SDP counterparty ids
 * are `counterparty_<uuid>` and therefore too long. This function creates a
 * reversible BVNK-facing id in `cp_<uuid_without_hyphens>` format. BVNK returns
 * this caller-provided value in customer/payment webhooks, letting handlers
 * reconstruct the SDP counterparty id and load by primary key.
 *
 * @param counterpartyId SDP counterparty primary key in `counterparty_<uuid>` format.
 * @returns BVNK customer `externalReference` in `cp_<32_hex_uuid>` format.
 * @throws AppError with `INTERNAL_ERROR` when the counterparty id cannot be
 * represented in BVNK's compact externalReference format.
 */
export function buildBvnkCustomerExternalReference(counterpartyId: string): string {
  const match = SDP_COUNTERPARTY_ID_PATTERN.exec(counterpartyId);
  if (!match) {
    throw internalError(
      `Malformed SDP counterparty id for BVNK externalReference: ${counterpartyId}`
    );
  }
  return `cp_${match.slice(1).join("").toLowerCase()}`;
}

/** Per funding-spec (fiat+token+destination) virtual wallet + rule. */
export interface BvnkOnrampRequestSpec {
  currency: string;
  network: string;
  destinationWalletAddress: string;
  fiatCurrency: string;
}

export interface BvnkOnrampPaymentRuleState {
  walletId?: string;
  walletName?: string;
  walletStatus?: string;
  ruleId?: string;
  ruleStatus?: string;
  bankAccount?: BvnkBankFundingDetails;
  request?: BvnkOnrampRequestSpec;
  provisioningError?: string;
}

const BVNK_WALLET_ACTIVE_STATUSES = new Set(["ACTIVE", "COMPLETED"]);

export function isBvnkWalletActive(status: string | undefined): boolean {
  return status !== undefined && BVNK_WALLET_ACTIVE_STATUSES.has(status.toUpperCase());
}

export interface BvnkPaymentRuleResolution {
  customer: BvnkCustomerResolution;
  entry: BvnkOnrampPaymentRuleState;
  onboardingStatus: BvnkOnboardingStatus;
}

export function readBvnkData(
  providerData: CounterpartyRow["provider_data"]
): Record<string, unknown> {
  const bvnk = providerData.bvnk;
  return bvnk && typeof bvnk === "object" ? (bvnk as Record<string, unknown>) : {};
}

export function readBvnkCustomer(
  providerData: CounterpartyRow["provider_data"]
): BvnkCustomerResolution {
  const customer = readBvnkData(providerData).customer;
  return customer && typeof customer === "object" ? (customer as BvnkCustomerResolution) : {};
}

export function readBvnkWallets(
  providerData: CounterpartyRow["provider_data"]
): Record<string, BvnkOnrampPaymentRuleState> {
  const wallets = readBvnkData(providerData).wallets;
  return wallets && typeof wallets === "object"
    ? (wallets as Record<string, BvnkOnrampPaymentRuleState>)
    : {};
}

/** Merchant-owned BVNK off-ramp wallet, one per fiat currency. */
export interface BvnkOfframpWallet {
  id: string;
  status?: string;
}

export function buildBvnkOfframpWalletName(
  fiatCurrency: RampFiatCurrency,
  counterpartyId: string
): string {
  return `sdp:offramp:${fiatCurrency}:${counterpartyId}`;
}

/**
 * Builds the BVNK wallet name for customer-owned on-ramp funding wallets.
 *
 * The name carries the SDP counterparty id and the deterministic on-ramp
 * payment rule fields so wallet lifecycle webhooks can update
 * `provider_data.bvnk.wallets[onrampPaymentRuleKey]` directly.
 *
 * @param counterpartyId SDP counterparty primary key.
 * @param onrampPaymentRuleKey Deterministic key from `buildBvnkOnrampPaymentRuleKey`.
 * @returns BVNK wallet name in
 * `sdp:onramp:<counterparty_id>:<fiat>:<crypto>_<network>:<destination>` format.
 */
export function buildBvnkOnrampWalletName(
  counterpartyId: string,
  onrampPaymentRuleKey: string
): string {
  const key = parseBvnkOnrampPaymentRuleKey(onrampPaymentRuleKey);
  return `sdp:onramp:${counterpartyId}:${key.fiatCurrency}:${key.cryptoCurrency}_${key.cryptoNetwork}:${key.destinationWalletAddress}`;
}

const BVNKOfframpWalletName = z.object({
  namespace: z.literal("sdp"),
  direction: z.literal("offramp"),
  fiatCurrency: z.enum(RAMP_FIAT_CURRENCIES),
  counterpartyId: z.string().min(1),
});

const BVNKOnrampWalletName = z.object({
  namespace: z.literal("sdp"),
  direction: z.literal("onramp"),
  counterpartyId: z.string().min(1),
  onrampKey: z.string().min(1),
});

export const BVNKWallet = z.discriminatedUnion("direction", [
  BVNKOfframpWalletName,
  BVNKOnrampWalletName,
]);

export type BVNKWallet = z.infer<typeof BVNKWallet>;

export function parseBvnkOfframpWalletName(
  walletName: string
): Extract<BVNKWallet, { direction: "offramp" }> {
  const parts = walletName.split(":");
  if (parts.length !== 4) {
    throw internalError(`Malformed BVNK off-ramp wallet name: ${walletName}`);
  }
  const [namespace, direction, fiatCurrency, counterpartyId] = parts;
  const parsed = BVNKOfframpWalletName.safeParse({
    namespace,
    direction,
    fiatCurrency,
    counterpartyId,
  });
  if (!parsed.success) {
    throw internalError(`Malformed BVNK off-ramp wallet name: ${walletName}`);
  }
  return parsed.data;
}

/**
 * Parses a customer-owned BVNK funding wallet name back into its SDP owner and
 * on-ramp entry key.
 *
 * @param walletName BVNK wallet `name` value.
 * @returns Parsed SDP counterparty id and `buildBvnkOnrampPaymentRuleKey` value.
 * @throws AppError with `INTERNAL_ERROR` when the name does not match the SDP
 * on-ramp wallet naming contract.
 */
export function parseBvnkOnrampWalletName(
  walletName: string
): Extract<BVNKWallet, { direction: "onramp" }> {
  const parts = walletName.split(":");
  if (parts.length !== 6) {
    throw internalError(`Malformed BVNK on-ramp wallet name: ${walletName}`);
  }
  const [namespace, direction, counterpartyId, fiatCurrency, cryptoRail, destinationWalletAddress] =
    parts;
  let onrampKey = `${fiatCurrency}:${cryptoRail}:${destinationWalletAddress}`;
  try {
    const key = parseBvnkOnrampPaymentRuleKey(onrampKey);
    onrampKey = buildBvnkOnrampPaymentRuleKey(
      key.fiatCurrency,
      key.cryptoCurrency,
      key.cryptoNetwork,
      key.destinationWalletAddress
    );
  } catch {
    throw internalError(`Malformed BVNK on-ramp wallet name: ${walletName}`);
  }
  const parsed = BVNKOnrampWalletName.safeParse({
    namespace,
    direction,
    counterpartyId,
    onrampKey,
  });
  if (!parsed.success) {
    throw internalError(`Malformed BVNK on-ramp wallet name: ${walletName}`);
  }
  return parsed.data;
}

export function readBvnkOfframpWallets(
  providerData: CounterpartyRow["provider_data"]
): Record<string, BvnkOfframpWallet> {
  const offramp = readRecord(readBvnkData(providerData).offramp)?.wallets;
  return offramp && typeof offramp === "object"
    ? (offramp as Record<string, BvnkOfframpWallet>)
    : {};
}

export function readBvnkOfframpWallet(
  providerData: CounterpartyRow["provider_data"],
  fiatCurrency: string
): BvnkOfframpWallet | undefined {
  return readBvnkOfframpWallets(providerData)[fiatCurrency];
}

/** A registered off-ramp payout beneficiary. PII-light: raw account details are not stored. */
export interface BvnkOfframpBeneficiary {
  /** `${fiatCurrency}:${hash(collectedData)}` — content-addressed so distinct bank details never collide. */
  key: string;
  fiatCurrency: string;
  accountType: string;
  createdAt: string;
}

export function readBvnkOfframpBeneficiaries(
  providerData: CounterpartyRow["provider_data"]
): Record<string, unknown> {
  const beneficiaries = readRecord(readBvnkData(providerData).offramp)?.beneficiaries;
  return beneficiaries && typeof beneficiaries === "object"
    ? (beneficiaries as Record<string, unknown>)
    : {};
}

function parseBvnkOfframpBeneficiary(key: string, value: unknown): BvnkOfframpBeneficiary {
  const { fiatCurrency, accountType, createdAt } = value as {
    fiatCurrency?: unknown;
    accountType?: unknown;
    createdAt?: unknown;
  };
  if (
    typeof fiatCurrency !== "string" ||
    typeof accountType !== "string" ||
    typeof createdAt !== "string"
  ) {
    throw internalError(`Malformed BVNK off-ramp beneficiary "${key}" in provider_data`);
  }
  return { key, fiatCurrency, accountType, createdAt };
}

export function readBvnkOfframpBeneficiaryByKey(
  providerData: CounterpartyRow["provider_data"],
  key: string
): BvnkOfframpBeneficiary | null {
  const value = readBvnkOfframpBeneficiaries(providerData)[key];
  return value === undefined ? null : parseBvnkOfframpBeneficiary(key, value);
}

export function latestBvnkOfframpBeneficiary(
  providerData: CounterpartyRow["provider_data"],
  fiatCurrency: string
): BvnkOfframpBeneficiary | null {
  const entries = Object.entries(readBvnkOfframpBeneficiaries(providerData))
    .filter(([key]) => key.startsWith(`${fiatCurrency}:`))
    .map(([key, value]) => parseBvnkOfframpBeneficiary(key, value))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries[0] ?? null;
}

/**
 * Schema for the logical components encoded into
 * `provider_data.bvnk.wallets[onrampPaymentRuleKey]`.
 */
export const BVNKOnrampPaymentRuleKey = z.object({
  fiatCurrency: z.enum(RAMP_FIAT_CURRENCIES),
  cryptoCurrency: z
    .string()
    .trim()
    .min(1)
    .regex(/^[A-Z0-9]+$/),
  cryptoNetwork: z.enum(BVNK_NETWORKS),
  destinationWalletAddress: z
    .string()
    .min(1)
    .refine((value) => !value.includes(":")),
});

export type BVNKOnrampPaymentRuleKey = z.infer<typeof BVNKOnrampPaymentRuleKey>;

/**
 * Builds the deterministic key for a BVNK on-ramp payment rule.
 *
 * This key identifies the exact funding rule SDP needs for one fiat funding
 * currency, one crypto asset/network destination, and one destination wallet.
 * It is stored under `provider_data.bvnk.wallets` and embedded into the BVNK
 * wallet name so webhook handlers can reverse it without scanning by wallet id.
 *
 * @param fiatCurrency Fiat currency the counterparty sends into the BVNK funding account.
 * @param cryptoCurrency Crypto asset BVNK delivers for the on-ramp, such as `USDC`.
 * @param cryptoNetwork Blockchain network BVNK delivers on, such as `SOLANA`.
 * @param destinationWalletAddress Destination wallet address that receives the on-ramped crypto.
 * @returns Serialized on-ramp payment rule key in `<fiat>:<crypto>_<network>:<destination>` format.
 * @throws AppError with `INTERNAL_ERROR` when inputs do not satisfy the SDP key contract.
 */
export function buildBvnkOnrampPaymentRuleKey(
  fiatCurrency: string,
  cryptoCurrency: string,
  cryptoNetwork: string,
  destinationWalletAddress: string
): string {
  const parsed = BVNKOnrampPaymentRuleKey.safeParse({
    fiatCurrency: fiatCurrency.trim().toUpperCase(),
    cryptoCurrency: cryptoCurrency.trim().toUpperCase(),
    cryptoNetwork: cryptoNetwork.trim().toUpperCase(),
    destinationWalletAddress,
  });
  if (!parsed.success) {
    throw internalError("Malformed BVNK on-ramp payment rule key input");
  }
  return `${parsed.data.fiatCurrency}:${parsed.data.cryptoCurrency}_${parsed.data.cryptoNetwork}:${parsed.data.destinationWalletAddress}`;
}

/**
 * Parses a stored BVNK on-ramp payment rule key back to its logical components.
 *
 * @param key Serialized key from `buildBvnkOnrampPaymentRuleKey`.
 * @returns Parsed fiat funding currency, on-ramped crypto asset/network, and destination wallet.
 * @throws AppError with `INTERNAL_ERROR` when the key no longer matches SDP's BVNK key contract.
 */
export function parseBvnkOnrampPaymentRuleKey(key: string): BVNKOnrampPaymentRuleKey {
  const parts = key.split(":");
  if (parts.length !== 3) {
    throw internalError(`Malformed BVNK on-ramp payment rule key: ${key}`);
  }
  const [fiatCurrency, cryptoRail, destinationWalletAddress] = parts;
  const cryptoNetwork = BVNK_NETWORKS_BY_LENGTH_DESC.find((network) =>
    cryptoRail.endsWith(`_${network}`)
  );
  if (!cryptoNetwork) {
    throw internalError(`Malformed BVNK on-ramp payment rule key: ${key}`);
  }
  const cryptoCurrency = cryptoRail.slice(0, -(cryptoNetwork.length + 1));
  const parsed = BVNKOnrampPaymentRuleKey.safeParse({
    fiatCurrency,
    cryptoCurrency,
    cryptoNetwork,
    destinationWalletAddress,
  });
  if (!parsed.success) {
    throw internalError(`Malformed BVNK on-ramp payment rule key: ${key}`);
  }
  return parsed.data;
}

export function readBvnkOnrampPaymentRuleState(
  providerData: CounterpartyRow["provider_data"],
  key: string
): BvnkOnrampPaymentRuleState {
  const entry = readBvnkWallets(providerData)[key];
  return entry && typeof entry === "object" ? entry : {};
}

export async function bvnkRuleReference(
  counterpartyId: string,
  onrampKey: string
): Promise<string> {
  return (await hashString(`bvnk-rule:${counterpartyId}:${onrampKey}`)).slice(0, 36);
}

export function buildBvnkRuleEntity(counterparty: CounterpartyRow): BvnkRuleEntity {
  const identity = counterparty.identity;
  const address = identity.address;
  const isCompany = counterparty.entity_type === "business";

  return {
    type: BVNK_ENTITY_TYPE[counterparty.entity_type],
    customerIdentifier: counterparty.external_id ?? counterparty.id,
    relationshipType: "SELF_OWNED",
    ...(isCompany
      ? { legalName: counterparty.display_name }
      : { firstName: identity.firstName, lastName: identity.lastName }),
    ...(identity.dateOfBirth ? { dateOfBirth: identity.dateOfBirth } : {}),
    ...(address
      ? {
          address: {
            addressLine1: address.line1,
            ...(address.line2 ? { addressLine2: address.line2 } : {}),
            ...(address.postalCode ? { postalCode: address.postalCode } : {}),
            city: address.city,
            countryCode: address.countryCode,
            country: address.countryCode,
            ...(address.subdivisionCode ? { stateCode: address.subdivisionCode } : {}),
          },
        }
      : {}),
  };
}

export function buildBvnkPartyDetails(
  counterparty: CounterpartyRow,
  role: "ORIGINATOR" | "BENEFICIARY"
): BvnkComplianceInput {
  const identity = counterparty.identity;

  return {
    partyDetails: [
      {
        type: role,
        entityType: BVNK_ENTITY_TYPE[counterparty.entity_type],
        relationshipType: "SELF_OWNED",
        firstName: identity.firstName,
        lastName: identity.lastName,
        ...(identity.dateOfBirth ? { dateOfBirth: identity.dateOfBirth } : {}),
        ...(identity.address?.countryCode ? { countryCode: identity.address.countryCode } : {}),
      },
    ],
  };
}

export function buildBvnkOnrampInstruction(
  resolution: BvnkPaymentRuleResolution,
  params: {
    network: string;
    destinationWalletAddress: string;
    fiatCurrency: string;
    mode: SdpEnvironment;
  }
): BvnkPaymentRampInstruction {
  const { customer, entry, onboardingStatus } = resolution;
  const verificationNote =
    params.mode === "sandbox"
      ? "Complete identity verification to activate your funding account. BVNK requires you to verify the counterparty through Sumsub. No information entered via the sandbox will be verified."
      : "Complete identity verification to activate your funding account. BVNK requires you to verify the counterparty through Sumsub.";
  const notesByStatus = {
    ready: `Fund your ${params.fiatCurrency} BVNK virtual account to receive crypto on ${params.network}.`,
    verification_required: verificationNote,
    verification_failed:
      "Identity verification was not approved, so this funding account can't be activated. Contact support if you believe this is a mistake.",
    provisioning: "Setting up your funding account; bank details will appear in a moment.",
    verifying: "Identity verification is in review; funding details will appear once approved.",
  } as const satisfies Record<BvnkOnboardingStatus, string>;
  const notes = notesByStatus[onboardingStatus];
  return {
    provider: "bvnk",
    kind: "fiat_funding",
    onboardingStatus,
    verificationUrl: customer.verificationUrl,
    ruleId: entry.ruleId,
    ruleStatus: entry.ruleStatus,
    fundingWalletId: entry.walletId,
    fiatCurrency: params.fiatCurrency,
    beneficiaryAddress: params.destinationWalletAddress,
    network: params.network,
    bankAccount: entry.bankAccount,
    instructionsNotes: notes,
  };
}

export function bvnkOnboardingRequirements(
  resolution: BvnkPaymentRuleResolution,
  direction: RampDirection
): CounterpartyRequirements {
  switch (resolution.onboardingStatus) {
    case "ready":
      return readyCounterparty("bvnk", direction);
    case "verification_required": {
      const { verificationUrl } = resolution.customer;
      if (!verificationUrl) {
        throw internalError('BVNK reported "verification_required" without a verificationUrl.');
      }
      return {
        provider: "bvnk",
        direction,
        status: "customer_verification_required",
        verificationUrl,
      };
    }
    case "verifying":
      return { provider: "bvnk", direction, status: "customer_verifying" };
    case "verification_failed":
      return { provider: "bvnk", direction, status: "customer_verification_failed" };
    case "provisioning":
      return { provider: "bvnk", direction, status: "funding_account_provisioning" };
    default: {
      const exhaustive: never = resolution.onboardingStatus;
      throw internalError(`Unhandled BVNK onboarding status: ${String(exhaustive)}`);
    }
  }
}

export function bvnkOnrampStatusFromProviderData(
  providerData: CounterpartyRow["provider_data"],
  params: { cryptoToken: string; fiatCurrency: string; destinationWalletAddress: string }
): CounterpartyRequirements {
  const direction: RampDirection = "onramp";
  const customer = readBvnkCustomer(providerData);
  if (!customer.customerReference) {
    return { provider: "bvnk", direction, status: "onboarding_not_started" };
  }
  if (!isBvnkCustomerVerified(customer.status)) {
    const phase = bvnkUnverifiedOnboardingStatus(customer.status);
    switch (phase) {
      case "verifying":
        return { provider: "bvnk", direction, status: "customer_verifying" };
      case "verification_failed":
        return { provider: "bvnk", direction, status: "customer_verification_failed" };
      case "verification_required": {
        if (!customer.verificationUrl) {
          throw internalError('BVNK reported "verification_required" without a verificationUrl.');
        }
        return {
          provider: "bvnk",
          direction,
          status: "customer_verification_required",
          verificationUrl: customer.verificationUrl,
        };
      }
      default: {
        const exhaustive: never = phase;
        throw internalError(`Unhandled BVNK verification phase: ${String(exhaustive)}`);
      }
    }
  }
  const { currency, network } = normalizeBvnkCurrencyAndNetwork(params.cryptoToken);
  const key = buildBvnkOnrampPaymentRuleKey(
    params.fiatCurrency,
    currency,
    network,
    params.destinationWalletAddress
  );
  const entry = readBvnkOnrampPaymentRuleState(providerData, key);
  if (entry.ruleId && entry.bankAccount?.accountNumber) {
    return { provider: "bvnk", direction, status: "ready" };
  }
  if (entry.provisioningError && !entry.ruleId) {
    return { provider: "bvnk", direction, status: "provisioning_failed" };
  }
  return { provider: "bvnk", direction, status: "funding_account_provisioning" };
}
