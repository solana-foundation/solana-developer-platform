import { assertValidAddress } from "@sdp/solana/address";
import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import type {
  BvnkBankFundingDetails,
  Counterparty,
  PaymentRampEstimate,
  PaymentRampEstimateFees,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp-support";
import { getCryptoRailAssetLabel, parseFiatCurrency } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import {
  badRequest,
  internalError,
  providerNotConfigured,
  providerUnavailable,
  SdpPaymentsError,
} from "../../../errors";
import { hmacSha256Base64 } from "../../../hash";
import { readRecord, readString } from "../../../json";
import { type ProviderRequestInit, providerFetch } from "../../fetch";
import {
  createProviderRampSupport,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  rampId,
  SOLANA_ASSET_TO_RAIL,
} from "../../shared";
import type {
  ProviderRampSupport,
  RampDumpReader,
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
  type BvnkVerificationStatus,
  buildBvnkOfframpReference,
  normalizeBvnkCurrencyAndNetwork,
} from "./provider-data";

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
  options?: { edgeBlocked?: boolean }
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
    throw new SdpPaymentsError(
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
    throw new SdpPaymentsError("PROVIDER_UNAVAILABLE", "BVNK returned a non-positive paid amount");
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
    return validateBvnkCounterparty(counterparty, options);
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
      throw new SdpPaymentsError(
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
