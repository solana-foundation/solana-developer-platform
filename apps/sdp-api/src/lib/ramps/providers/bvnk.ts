import type {
  BvnkBankFundingDetails,
  BvnkOnboardingStatus,
  BvnkPaymentRampExecution,
  BvnkPaymentRampInstruction,
  Counterparty,
  CounterpartyEntityType,
  PaymentRampEstimate,
  PaymentRampEstimateFees,
  PaymentRampExecution,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp-support";
import { getCryptoRailAssetLabel, parseFiatCurrency } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@/lib/amount";
import { AppError, badRequest, internalError, providerNotConfigured } from "@/lib/errors";
import { hashString, hmacSha256Base64, verifyHmacSha256Base64 } from "@/lib/hash";
import { type ProviderRequestInit, providerFetch } from "../fetch";
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

  const apiBaseUrl =
    env.BVNK_API_BASE_URL?.trim() ||
    (mode === "sandbox" ? BVNK_SANDBOX_API_URL : BVNK_PRODUCTION_API_URL);
  try {
    new URL(apiBaseUrl);
  } catch {
    throw new AppError("INTERNAL_ERROR", "BVNK API URL configuration is invalid.");
  }

  return { auth: { authId, secretKey }, walletId, apiBaseUrl };
}

type BvnkNetwork =
  | "ALGORAND"
  | "CARDANO"
  | "BITCOIN_CASH"
  | "BINANCE"
  | "BITCOIN"
  | "DOGECOIN"
  | "ETHEREUM"
  | "LITECOIN"
  | "POLYGON"
  | "SOLANA"
  | "TRON"
  | "RIPPLE";

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

function mapBvnkPaymentStatus(status: string | undefined): PaymentRampExecution["status"] {
  if (!status) return "pending";
  const normalized = status.trim().toUpperCase();
  if (
    normalized.includes("COMPLETE") ||
    normalized.includes("PAID") ||
    normalized.includes("SUCCESS")
  ) {
    return "completed";
  }
  if (normalized.includes("PROCESS")) return "processing";
  if (
    normalized.includes("FAIL") ||
    normalized.includes("EXPIRE") ||
    normalized.includes("CANCEL") ||
    normalized.includes("REJECT")
  ) {
    return "failed";
  }
  return "pending";
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
  secretKey: string
): Promise<string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const resource = `${url.pathname}${url.search}`;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");

  const normalized = [
    "hawk.1.header",
    ts,
    nonce,
    method,
    resource,
    url.hostname.toLowerCase(),
    port,
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
    return new AppError(
      "PROVIDER_UNAVAILABLE",
      `BVNK request was blocked at the edge (CloudFront/WAF, status ${status}) before reaching the API. This is typically IP rate-limiting, not a credential issue; retry shortly or from a different egress.`
    );
  }
  if (status === 401 || status === 403) {
    return new AppError(
      "PROVIDER_NOT_CONFIGURED",
      `BVNK rejected the request credentials (status ${status}). Check the BVNK Hawk auth configuration.`
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

interface BvnkEstimateResponse {
  externalId?: string;
}

interface BvnkPaymentSummary {
  uuid?: string;
  status?: string;
  redirectUrl?: string;
  reference?: string;
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
  status?: string;
  bankAccount?: BvnkBankFundingDetails;
}

export interface CreateBvnkAgreementSessionInput {
  customerType: BvnkEntityType;
  countryCode: string;
  useCase: string;
}

export interface CreateBvnkCustomerInput {
  externalReference: string;
  signedAgreementSessionReference: string;
  individual: Record<string, unknown>;
}

export interface CreateBvnkFiatWalletInput {
  customerReference: string;
  name: string;
  currencyCode: string;
  walletProfile: string;
  idempotencyKey: string;
}

interface BvnkWalletProfile {
  id: string;
  currencies: string[];
  methods: string[];
}

function parseBvnkWalletProfileId(payload: unknown, currency: string): string | undefined {
  const content = asRecord(payload).content;
  if (!Array.isArray(content)) return undefined;
  const profiles = content.map((entry): BvnkWalletProfile => {
    const profile = asRecord(entry);
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
      kind: "wallet";
      event: string;
      customerReference?: string;
      walletId?: string;
      walletStatus?: string;
      bankAccount?: BvnkBankFundingDetails;
    }
  | {
      kind: "customer";
      event: string;
      customerReference?: string;
      customerStatus?: string;
      verificationUrl?: string;
    }
  | {
      kind: "payment";
      event: string;
      customerId?: string;
      walletId?: string;
      status?: string;
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseBvnkAgreementSession(payload: unknown): BvnkAgreementSession {
  const data = asRecord(payload);
  const reference = readString(data.reference);
  if (!reference) {
    throw badRequest("BVNK agreement session response is missing a reference");
  }
  const agreements = Array.isArray(data.agreements)
    ? data.agreements.map((entry): BvnkAgreement => {
        const a = asRecord(entry);
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

/**
 * Whether a cached BVNK customer status counts as fully verified. The customer
 * KYC enum's success state is VERIFIED, but webhook events also report terminal
 * success as COMPLETED/APPROVED — treat all as verified.
 */
export function isBvnkCustomerVerified(status: string | undefined): boolean {
  return status !== undefined && BVNK_VERIFIED_STATUSES.has(status.toUpperCase());
}

function parseBvnkCustomerState(payload: unknown): BvnkCustomerState {
  const data = asRecord(payload);
  const reference = readString(data.reference);
  if (!reference) {
    throw badRequest("BVNK customer response is missing a reference");
  }
  const verification = asRecord(data.verification);
  return {
    reference,
    status: readString(data.status) ?? "PENDING",
    verificationStatus: parseBvnkVerificationStatus(verification.status),
    verificationUrl: readString(verification.url),
  };
}

function parseBvnkLedgersBankAccount(
  data: Record<string, unknown>
): BvnkBankFundingDetails | undefined {
  const ledgers = Array.isArray(data.ledgers) ? data.ledgers : [];
  for (const entry of ledgers) {
    const ledger = asRecord(entry);
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
  const data = asRecord(payload);
  const id = readString(data.id);
  if (!id) {
    throw badRequest("BVNK wallet response is missing an id");
  }
  const status = readString(data.status);
  const instruments = Array.isArray(data.paymentInstruments) ? data.paymentInstruments : [];
  for (const entry of instruments) {
    const inst = asRecord(entry);
    if (readString(inst.type) !== "FIAT") continue;
    const bank = asRecord(inst.bankDetails);
    return {
      id,
      status,
      bankAccount: {
        accountNumber: readString(inst.accountNumber),
        code: readString(bank.bic),
        paymentReference: readString(inst.remittanceInformationPrefix),
        bankName: readString(bank.name),
      },
    };
  }
  return { id, status };
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
      config.auth.secretKey
    );

    const { response, raw, parsed } = await providerFetch(this.id, url.toString(), {
      ...init,
      headers: { Authorization: authorization, ...init.headers },
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
    const base = env.BVNK_RAMP_RAILS_API_BASE_URL?.trim() || "https://api.sandbox.bvnk.com/";
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
    if (!(await verifyHmacSha256Base64(rawBody, signature, secret))) {
      throw new AppError("UNAUTHORIZED", "Invalid BVNK webhook signature", { provider: this.id });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw badRequest("BVNK webhook body must be valid JSON", {
        provider: this.id,
      });
    }
    return { provider: this.id, payload };
  }

  /**
   * Maps a BVNK webhook to a typed event by its `event` discriminator. Each
   * event carries the customer in a different field and a different `status`
   * (customer KYC vs wallet lifecycle), so they're mapped explicitly rather than
   * scraped generically. Unrecognised events return an `ignore` kind.
   */
  parseBvnkWebhookEvent(payload: unknown): BvnkWebhookEvent {
    const root = asRecord(payload);
    const event = readString(root.event) ?? "";
    const data = asRecord(root.data);

    switch (event) {
      case "bvnk:customers:status-change":
        return {
          kind: "customer",
          event,
          customerReference: readString(data.customerId),
          customerStatus: readString(data.status),
        };
      case "bvnk:platform:customer:update":
        return {
          kind: "customer",
          event,
          customerReference: readString(data.reference),
          verificationUrl: readString(asRecord(data.verification).url),
        };
      case "ledger:v2:wallet:status-change": {
        const wallet = parseBvnkFiatWallet(data);
        return {
          kind: "wallet",
          event,
          customerReference: readString(asRecord(data.customer).id),
          walletId: wallet.id,
          walletStatus: readString(data.status),
          bankAccount: wallet.bankAccount,
        };
      }
      case "bvnk:ledger:wallet:create":
        return {
          kind: "wallet",
          event,
          customerReference: readString(data.customerReference),
          walletId: readString(data.id),
          walletStatus: readString(data.status),
          bankAccount: parseBvnkLedgersBankAccount(data),
        };
      case "bvnk:payment:crypto:status-change":
        return {
          kind: "payment",
          event,
          customerId: readString(data.customerId),
          walletId: readString(data.walletId),
          status: readString(data.status),
        };
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
    input: { customerReference: string; currency: string }
  ): Promise<string> {
    const config = readBvnkConfig(env, mode);
    const query = `customerId:${input.customerReference} AND currency:${input.currency}`;
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
        customerId: input.customerReference,
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

  /**
   * BVNK quotes its on-ramp rate only at quote time, so an upfront estimate is
   * unavailable; ESTIMATE_NOT_AVAILABLE lets the cross-provider estimate sweep
   * surface BVNK as "unsupported" for the pair. The rest of the on-ramp (KYC
   * customer + virtual wallet + rule) is stateful and orchestrated in the
   * payments handler via `ensureBvnkOnramp`, so BVNK omits the on-ramp
   * quote/execute methods entirely.
   */
  async estimateOnramp(
    _ctx: RampRuntimeContext,
    _input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    throw new AppError("ESTIMATE_NOT_AVAILABLE", "BVNK on-ramp rate is only known at quote time.", {
      provider: this.id,
    });
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
    const config = readBvnkConfig(env, mode);
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
    const fiatCurrency = input.fiatCurrency;
    const paidRequiredAmount = toPositiveAmount(input.cryptoAmount, "cryptoAmount");
    const reference = rampId("sdp_offramp");
    const complianceDetails = buildBvnkComplianceDetails(input.bvnkCompliance, {
      requirePartyDetails: true,
    });

    const estimate = await this.request<BvnkEstimateResponse>(config, "/api/v1/pay/estimate", {
      method: "POST",
      body: {
        walletId: config.walletId,
        walletCurrency: fiatCurrency,
        paidCurrency: currency,
        paidRequiredAmount,
        reference,
        network,
        complianceDetails,
      },
    });
    if (!estimate.externalId) {
      throw badRequest("BVNK estimate response is missing externalId");
    }

    const summary = await this.request<BvnkPaymentSummary>(
      config,
      `/api/v1/pay/estimate/${encodeURIComponent(estimate.externalId)}/accept`,
      {
        method: "POST",
        body: {
          customerId: input.customerId ?? input.externalCustomerId,
          payOutDetails: { currency, address: input.sourceWalletAddress, network },
          complianceDetails,
        },
      }
    );
    if (!summary.uuid) {
      throw badRequest("BVNK off-ramp did not return a payment uuid");
    }
    if (!summary.redirectUrl) {
      throw badRequest("BVNK off-ramp did not return a redirect URL");
    }
    return {
      provider: "bvnk",
      id: summary.uuid,
      status: mapBvnkPaymentStatus(summary.status),
      deliveryMode: "hosted",
      hostedUrl: summary.redirectUrl,
    };
  }

  async executeOnramp(
    { mode }: RampRuntimeContext,
    input: BvnkExecuteOnrampInput
  ): Promise<BvnkPaymentRampExecution> {
    const resolution = input.bvnkPaymentRule;
    const { network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
    const fiatCurrency = input.fiatCurrency;
    const instruction = buildBvnkOnrampInstruction(resolution, {
      network,
      destinationWalletAddress: input.destinationWalletAddress,
      fiatCurrency,
      mode,
    });
    const reference =
      resolution.onboardingStatus === "ready"
        ? resolution.entry.ruleId
        : resolution.customer.customerReference;
    if (!reference)
      throw internalError(
        `BVNK on-ramp missing reference at status "${resolution.onboardingStatus}".`
      );
    return {
      id: reference,
      provider: "bvnk",
      status: "pending",
      reference,
      paymentInstructions: [instruction],
    };
  }

  async executeOfframp(
    { env, mode }: RampRuntimeContext,
    input: BvnkExecuteOfframpInput
  ): Promise<BvnkPaymentRampExecution> {
    const customerId = input.providerCustomer.customerReference;
    if (!customerId) {
      throw badRequest("providerCustomer.customerReference is required for BVNK off-ramp.");
    }

    const config = readBvnkConfig(env, mode);
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
    const fiatCurrency = input.fiatCurrency;
    const paidRequiredAmount = toPositiveAmount(input.cryptoAmount, "cryptoAmount");
    const externalReference = rampId("sdp_offramp");
    const complianceDetails = buildBvnkComplianceDetails(input.bvnkCompliance, {
      requirePartyDetails: true,
    });

    const estimate = await this.request<BvnkEstimateResponse>(config, "/api/v1/pay/estimate", {
      method: "POST",
      body: {
        walletId: config.walletId,
        walletCurrency: fiatCurrency,
        paidCurrency: currency,
        paidRequiredAmount,
        reference: externalReference,
        network,
        complianceDetails,
      },
    });
    if (!estimate.externalId) {
      throw badRequest("BVNK estimate response is missing externalId");
    }

    const summary = await this.request<BvnkPaymentSummary>(
      config,
      `/api/v1/pay/estimate/${encodeURIComponent(estimate.externalId)}/accept`,
      {
        method: "POST",
        body: {
          customerId,
          payOutDetails: { currency, address: input.sourceWalletAddress, network },
          complianceDetails,
        },
      }
    );
    if (!summary.uuid) {
      throw badRequest("BVNK off-ramp did not return a payment uuid");
    }

    return {
      id: rampId("ramp"),
      provider: "bvnk",
      status: mapBvnkPaymentStatus(summary.status),
      redirectUrl: summary.redirectUrl,
      reference: summary.uuid,
    };
  }
}

/** Shared, one-per-counterparty BVNK customer (KYC) state. */
export interface BvnkCustomerResolution {
  externalReference?: string;
  customerReference?: string;
  status?: string;
  verificationStatus?: BvnkVerificationStatus;
  verificationUrl?: string;
}

/** Per funding-spec (fiat+token+destination) virtual wallet + rule. */
export interface BvnkOnrampEntry {
  walletId?: string;
  walletStatus?: string;
  ruleId?: string;
  ruleStatus?: string;
  bankAccount?: BvnkBankFundingDetails;
}

const BVNK_WALLET_ACTIVE_STATUSES = new Set(["ACTIVE", "COMPLETED"]);

export function isBvnkWalletActive(status: string | undefined): boolean {
  return status !== undefined && BVNK_WALLET_ACTIVE_STATUSES.has(status.toUpperCase());
}

export interface BvnkPaymentRuleResolution {
  customer: BvnkCustomerResolution;
  entry: BvnkOnrampEntry;
  onboardingStatus: BvnkOnboardingStatus;
}

export interface BvnkExecuteOnrampInput {
  destinationWalletAddress: string;
  cryptoToken: string;
  fiatCurrency: RampFiatCurrency;
  bvnkPaymentRule: BvnkPaymentRuleResolution;
}

export interface BvnkExecuteOfframpInput {
  sourceWalletAddress: string;
  cryptoToken: string;
  fiatCurrency: RampFiatCurrency;
  cryptoAmount: string;
  providerCustomer: BvnkCustomerResolution;
  bvnkCompliance?: BvnkComplianceInput;
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
): Record<string, BvnkOnrampEntry> {
  const wallets = readBvnkData(providerData).wallets;
  return wallets && typeof wallets === "object" ? (wallets as Record<string, BvnkOnrampEntry>) : {};
}

export function bvnkOnrampKey(
  fiatCurrency: string,
  currency: string,
  network: string,
  destinationWalletAddress: string
): string {
  return `${fiatCurrency}:${currency}_${network}:${destinationWalletAddress}`;
}

export function readBvnkOnrampEntry(
  providerData: CounterpartyRow["provider_data"],
  key: string
): BvnkOnrampEntry {
  const entry = readBvnkWallets(providerData)[key];
  return entry && typeof entry === "object" ? entry : {};
}

export function findBvnkWalletEntryKey(
  providerData: CounterpartyRow["provider_data"],
  walletId: string
): string | undefined {
  for (const [key, entry] of Object.entries(readBvnkWallets(providerData))) {
    if (entry && typeof entry === "object" && entry.walletId === walletId) return key;
  }
  return undefined;
}

/**
 * Deterministic BVNK customer externalReference for a counterparty so BVNK
 * dedupes (one customer per counterparty) even if our cached reference is lost.
 * BVNK caps externalReference at 36 chars; `sdp_` + 32 alphanumerics fits.
 */
export function bvnkCustomerExternalReference(counterpartyId: string): string {
  return `sdp_${counterpartyId.replace(/[^a-zA-Z0-9]/g, "").slice(-32)}`;
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
    provisioning: "Setting up your funding account; bank details will appear in a moment.",
    verifying: "Identity verification is in review; funding details will appear once approved.",
  } as const satisfies Record<BvnkOnboardingStatus, string>;
  const notes = notesByStatus[onboardingStatus];
  return {
    provider: "bvnk",
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
