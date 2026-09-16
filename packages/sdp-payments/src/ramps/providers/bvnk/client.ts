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
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
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
import { isSolanaCryptoAsset, rampId, UNREPORTED_COUNTRY_SUPPORT } from "../../shared";
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
import { discoverBvnkCurrencyAndRails } from "./currencies";
import {
  type BvnkComplianceInput,
  type BvnkNetwork,
  buildBvnkOfframpReference,
  normalizeBvnkCurrencyAndNetwork,
} from "./provider-data";
import {
  type BvnkAgreementSession,
  type BvnkChannelAddress,
  type BvnkChannelResponse,
  type BvnkCustomer,
  type BvnkCustomerCreated,
  type BvnkCustomerSearchV2,
  type BvnkErrorEnvelopeParse,
  type BvnkLedgerWalletProfilesV2,
  type BvnkLedgerWalletV2,
  type BvnkPayoutEstimateResponse,
  type BvnkRuleResponse,
  bvnkAgreementSessionSchema,
  bvnkChannelResponseSchema,
  bvnkCustomerCreatedSchema,
  bvnkCustomerSchema,
  bvnkCustomerSearchV2Schema,
  bvnkErrorEnvelopeSchema,
  bvnkEstimateFiatCurrencySchema,
  bvnkPayoutEstimateResponseSchema,
  bvnkQuoteEstimateResponseSchema,
  bvnkRuleResponseSchema,
  bvnkV2LedgerWalletSchema,
  bvnkV2WalletProfilesSchema,
  type CreateBvnkAgreementSessionInput,
  type CreateBvnkCustomerInput,
  type CreateBvnkLedgerWalletV2Input,
  type CreateBvnkOnrampRuleInput,
  type ListBvnkLedgerWalletProfilesV2Input,
  type SignBvnkAgreementSessionInput,
} from "./schemas";

const BVNK_PRODUCTION_API_URL = "https://api.bvnk.com";
export const BVNK_SANDBOX_API_URL = "https://api.sandbox.bvnk.com";

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
  /** Explicit pay-in rail; the sandbox otherwise auto-routes USD to ACH_SAME_DAY, which customer wallets reject (payment:0202). */
  method?: string;
}

// SANDBOX ONLY: synthetic originator (fiat sender) bank accounts for pay-in
// simulations. The real buyer's funding bank is never stored; BVNK just needs
// a format-valid account to accept the simulated deposit. Never used in prod.
const SANDBOX_ORIGINATOR_BANK_ACCOUNTS: Record<string, BvnkSandboxBankAccount> = {
  USD: {
    // biome-ignore lint/security/noSecrets: synthetic sandbox account, not a credential
    accountNumber: "000123456789",
    accountNumberFormat: "ABA",
    bankCode: "021000021",
    method: "ACH",
  },
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

  return { auth: { authId, secretKey }, walletId, apiBaseUrl };
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
  secretKey: string
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
    url.hostname,
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
      "BVNK request was forbidden (status 403). Check the BVNK Hawk auth/account permissions and that the API egress IP is allowlisted on the merchant account."
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

/**
 * Appends BVNK's error code and message to the status-only failure message so the
 * caller can tell an idempotency conflict from a bound reference or a validation error.
 *
 * @param status - HTTP status BVNK returned.
 * @param envelope - Parsed BVNK error envelope, when the body was JSON.
 * @returns The failure message, enriched when BVNK supplied a code or message.
 */
function describeBvnkFailure(status: number, envelope: BvnkErrorEnvelopeParse): string {
  const base = `BVNK request failed with status ${status}`;
  if (!envelope.success) {
    return base;
  }
  const parts = [envelope.data.code, envelope.data.message].filter(
    (part): part is string => part !== undefined
  );
  return parts.length === 0 ? base : `${base}: ${parts.join(" ")}`;
}

function parseBvnkValidationDetails(envelope: BvnkErrorEnvelopeParse): {
  code?: string;
  errors?: Record<string, string[]>;
} {
  if (!envelope.success) {
    return {};
  }
  return {
    ...(envelope.data.code === undefined ? {} : { code: envelope.data.code }),
    ...(envelope.data.details?.errors === undefined
      ? {}
      : { errors: envelope.data.details.errors }),
  };
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
    },
    options?: { allowEmpty?: boolean }
  ): Promise<unknown> {
    const url = new URL(path, config.apiBaseUrl);
    const authorization = await buildBvnkHawkAuthorizationHeader(
      url,
      init.method,
      config.auth.authId,
      config.auth.secretKey
    );

    const { response, raw, parsed } = await providerFetch(this.id, url.toString(), {
      ...init,
      headers: {
        Authorization: authorization,
        ...init.headers,
      },
    });

    if (!response.ok) {
      const envelope = bvnkErrorEnvelopeSchema.safeParse(parsed);
      throw mapBvnkErrorStatus(response.status, describeBvnkFailure(response.status, envelope), {
        edgeBlocked: isEdgeBlockBody(parsed, raw),
        details: response.status === 400 ? parseBvnkValidationDetails(envelope) : undefined,
      });
    }

    if (parsed === undefined) {
      if (options?.allowEmpty) {
        return undefined;
      }
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
    return discoverBvnkCurrencyAndRails(context);
  }

  /**
   * Creates a v1 agreement session for a prospective BVNK customer. The
   * customer type and use case are fixed constants of the SDP individual on-ramp.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Residence country whose agreement set the session mints.
   * @returns The created agreement session with its static document links.
   */
  async createAgreementSession(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkAgreementSessionInput
  ): Promise<BvnkAgreementSession> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v1/customers/agreement/sessions", {
      method: "POST",
      body: {
        customerType: "INDIVIDUAL",
        countryCode: input.countryCode,
        useCase: "EMBEDDED_FIAT_ACCOUNTS",
      },
    });
    return bvnkAgreementSessionSchema.parse(response);
  }

  /**
   * Signs a v1 agreement session with the consenting end-user IP. BVNK returns
   * an empty 204, which the client treats as success with no body.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Session reference and the consenting user's IP address.
   * @returns Nothing.
   */
  async signAgreementSession(
    { env, mode }: RampRuntimeContext,
    input: SignBvnkAgreementSessionInput
  ): Promise<void> {
    const config = readBvnkConfig(env, mode);
    await this.request(
      config,
      `/platform/v1/customers/agreement/sessions/${encodeURIComponent(input.reference)}`,
      { method: "PUT", body: { status: "SIGNED", ipAddress: input.ipAddress } },
      { allowEmpty: true }
    );
  }

  /**
   * Creates a v1 individual BVNK customer from a signed agreement session and
   * the collected PII pack.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Idempotency key, the partner-supplied external reference, the
   * signed session reference, and the individual request body.
   * @returns The created customer reference and acknowledgment status.
   */
  async createCustomer(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkCustomerInput
  ): Promise<BvnkCustomerCreated> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v1/customers", {
      method: "POST",
      headers: { "X-Idempotency-Key": input.idempotencyKey },
      body: {
        type: "individual",
        externalReference: input.externalReference,
        signedAgreementSessionReference: input.signedAgreementSessionReference,
        individual: input.individual,
      },
    });
    return bvnkCustomerCreatedSchema.parse(response);
  }

  /**
   * Retrieves a v1 BVNK customer, including its current verification link.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - BVNK customer reference (a uuid).
   * @returns The typed customer response, including verification when present.
   */
  async getCustomer(
    { env, mode }: RampRuntimeContext,
    input: { reference: string }
  ): Promise<BvnkCustomer> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/platform/v1/customers/${encodeURIComponent(input.reference)}`,
      { method: "GET" }
    );
    return bvnkCustomerSchema.parse(response);
  }

  /**
   * Searches v2 customers by the partner-supplied externalReference. A v1
   * customer created with externalReference X resolves here with its v2 id and
   * status — used to recover when a v1 create reports the externalReference as
   * already taken (probe Q6c).
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - The externalReference the v1 create was retried with.
   * @returns The matching customer id and status.
   */
  async searchCustomersV2ByReference(
    { env, mode }: RampRuntimeContext,
    input: { reference: string }
  ): Promise<BvnkCustomerSearchV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/platform/v2/customers?reference=${encodeURIComponent(input.reference)}`,
      { method: "GET" }
    );
    return bvnkCustomerSearchV2Schema.parse(response);
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
    const { method, ...bankAccount } = sandboxOriginatorBankAccount(input.currency);
    return this.request(config, "/payment/v2/payins/simulation", {
      method: "POST",
      body: {
        walletId: input.walletId,
        amount: input.amount,
        currency: input.currency,
        remittanceInformation,
        ...(method === undefined ? {} : { method }),
        originator: {
          name: input.originatorName,
          bankAccount,
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
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(
      getCryptoRailAssetLabel(input.assetRail)
    );
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
