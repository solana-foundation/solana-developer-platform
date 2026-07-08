import {
  type Counterparty,
  type LightsparkPaymentRampInstruction,
  type LightsparkProviderPaymentRampInstruction,
  type PaymentRampEstimate,
  type PaymentRampExecutionStatus,
  type PaymentRampQuote,
  type PaymentRampQuoteCurrency,
  type SdpEnvironment,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import {
  type CryptoAssetSymbol,
  getCryptoRailAssetLabel,
  parseFiatCurrency,
} from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { formatDecimalAmount, parseDecimalAmount } from "@/lib/amount";
import { AppError, badRequest, providerNotConfigured, providerUnavailable } from "@/lib/errors";
import { assertValidAddress, isAddress } from "@/lib/solana";
import { type ProviderRequestInit, providerFetchJson } from "../../fetch";
import {
  basicAuthHeader,
  createProviderRampSupport,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  requireEnv,
  SOLANA_ASSET_TO_RAIL,
} from "../../shared";
import type {
  ProviderRampSupport,
  RampDumpReader,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampRuntimeContext,
  ValidateCounterpartyOptions,
} from "../../types";
import { lightsparkCounterpartyRequirements } from "./counterparty";

const LIGHTSPARK_DEFAULT_GRID_API_URL = "https://api.lightspark.com/grid/2025-10-13";

function readLightsparkConfig(
  env: Record<string, string | undefined>,
  mode: SdpEnvironment
): LightsparkConfig {
  const tokenId = (
    mode === "sandbox" ? env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID : env.LIGHTSPARK_GRID_CLIENT_ID
  )?.trim();
  const clientSecret = (
    mode === "sandbox"
      ? env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET
      : env.LIGHTSPARK_GRID_CLIENT_SECRET
  )?.trim();

  if (!tokenId || !clientSecret) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "Lightspark sandbox is not configured. Set LIGHTSPARK_GRID_SANDBOX_CLIENT_ID and LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET."
        : "Lightspark is not configured. Set LIGHTSPARK_GRID_CLIENT_ID and LIGHTSPARK_GRID_CLIENT_SECRET."
    );
  }

  return { tokenId, clientSecret, apiBaseUrl: LIGHTSPARK_DEFAULT_GRID_API_URL };
}

function normalizeLightsparkCurrencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(normalized)) {
    throw badRequest("cryptoToken must be a valid Lightspark currency code");
  }
  return normalized;
}

function getLightsparkCurrencyDecimals(currencyCode: string): number {
  const normalized = currencyCode.trim().toUpperCase();
  if (normalized === "BTC") return 8;
  if (isSolanaCryptoAsset(normalized)) return WELL_KNOWN_TOKENS[normalized].decimals;
  throw new AppError(
    "BAD_REQUEST",
    `Unsupported lightspark cryptoToken: ${currencyCode}. Supported values: BTC, ${Object.keys(WELL_KNOWN_TOKENS).join(", ")}`
  );
}

function assertLightsparkInstructionCryptoAsset(value: string | undefined): CryptoAssetSymbol {
  if (!value?.trim()) {
    throw providerUnavailable("Lightspark Solana wallet instruction is missing assetType.");
  }
  const normalized = normalizeLightsparkCurrencyCode(value);
  if (!isSolanaCryptoAsset(normalized)) {
    throw providerUnavailable(`Lightspark returned unsupported crypto asset: ${normalized}.`);
  }
  return normalized;
}

function assertLightsparkAccountId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw badRequest(`${fieldName} is required for lightspark`);
  }
  if (!normalized.includes(":")) {
    throw new AppError(
      "BAD_REQUEST",
      `${fieldName} must be a Lightspark account identifier (for example: ExternalAccount:...)`
    );
  }
  return normalized;
}

function toLightsparkMinorUnitsInteger(value: bigint, fieldName: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw badRequest(`${fieldName} is too large for Lightspark quote minor units`);
  }
  return Number(value);
}

function mapLightsparkQuoteStatus(status: string | undefined): PaymentRampExecutionStatus {
  if (!status) return "pending";
  const normalized = status.trim().toUpperCase();
  if (normalized === "COMPLETED") return "completed";
  if (normalized === "PROCESSING") return "processing";
  if (normalized === "FAILED" || normalized === "EXPIRED") return "failed";
  return "pending";
}

function isGridRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readRequiredGridString(
  record: Record<string, unknown>,
  field: string,
  payloadName: string
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${payloadName} is missing ${field}`);
  }
  return value.trim();
}

interface LightsparkExternalAccount {
  id?: string;
  status?: string;
  platformAccountId?: string;
  accountInfo?: { accountType?: string; address?: string };
}

export interface LightsparkExternalAccountResolution {
  id: string;
  status: string;
}

function parseLightsparkExternalAccountResolution(
  payload: unknown
): LightsparkExternalAccountResolution {
  if (!isGridRecord(payload)) {
    throw badRequest("Lightspark external account response must be an object");
  }
  return {
    id: readRequiredGridString(payload, "id", "Lightspark external account"),
    status: readRequiredGridString(payload, "status", "Lightspark external account"),
  };
}

function parseLightsparkExternalAccount(payload: unknown): LightsparkExternalAccount {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }
  const raw = payload as {
    id?: unknown;
    status?: unknown;
    platformAccountId?: unknown;
    accountInfo?: { accountType?: unknown; address?: unknown };
  };
  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    platformAccountId:
      typeof raw.platformAccountId === "string" ? raw.platformAccountId : undefined,
    accountInfo:
      raw.accountInfo && typeof raw.accountInfo === "object"
        ? {
            accountType:
              typeof raw.accountInfo.accountType === "string"
                ? raw.accountInfo.accountType
                : undefined,
            address:
              typeof raw.accountInfo.address === "string" ? raw.accountInfo.address : undefined,
          }
        : undefined,
  };
}

/** Connection details for live Grid API calls. */
export interface LightsparkConfig {
  tokenId: string;
  clientSecret: string;
  apiBaseUrl: string;
}

export type LightsparkCustomerType = "INDIVIDUAL" | "BUSINESS";

export interface CreateLightsparkCustomerInput {
  platformCustomerId: string;
  customerType: LightsparkCustomerType;
  fullName: string;
  email?: string;
}

export interface LightsparkCustomer {
  id: string;
}

export interface LightsparkCustomerResolution {
  customerId: string;
}

interface GridCreateCustomerBody {
  platformCustomerId: string;
  customerType: LightsparkCustomerType;
  fullName: string;
  email?: string;
}

interface GridCustomerResponse {
  id: string;
}

interface GridCustomerListResponse {
  data: GridCustomerResponse[];
}

interface GridCreateQuoteBody {
  source: {
    sourceType: "REALTIME_FUNDING";
    customerId: string;
    currency: string;
    /** Required by Grid when `currency` is a stablecoin — which deposit network to generate. */
    cryptoNetwork?: "SOLANA";
  };
  destination: {
    destinationType: "ACCOUNT";
    accountId: string;
    currency: string;
  };
  lockedCurrencySide: "SENDING" | "RECEIVING";
  lockedCurrencyAmount: number;
  description: string;
}

interface GridPaymentInstruction {
  accountOrWalletInfo: {
    accountType: string;
    accountNumber?: string;
    routingNumber?: string;
    paymentRails?: string[];
    reference?: string;
    bankName?: string;
    address?: string;
    assetType?: string;
  };
  instructionsNotes?: string;
  isPlatformAccount?: boolean;
}

interface GridCurrency {
  code: string;
  decimals: number;
  name?: string;
  symbol?: string;
}

interface GridQuoteResponse {
  id: string;
  quoteStatus?: string;
  paymentInstructions?: GridPaymentInstruction[];
  exchangeRate: number;
  totalSendingAmount: number;
  sendingCurrency: GridCurrency;
  totalReceivingAmount: number;
  receivingCurrency: GridCurrency;
  feesIncluded: number;
  expiresAt: string;
}

interface GridExchangeRate {
  sourceCurrency: GridCurrency;
  destinationCurrency: GridCurrency;
  sendingAmount: number;
  receivingAmount: number;
  exchangeRate: number;
  fees: { fixed: number };
  minSendingAmount: number;
  maxSendingAmount: number;
}

interface GridExchangeRatesResponse {
  data: GridExchangeRate[];
}

function gridExchangeRatesPath(params: {
  sourceCurrency: string;
  destinationCurrency: string;
  sendingAmount?: number;
}): string {
  const query = new URLSearchParams();
  query.set("sourceCurrency", params.sourceCurrency);
  query.set("destinationCurrency", params.destinationCurrency);
  if (params.sendingAmount !== undefined) {
    query.set("sendingAmount", String(params.sendingAmount));
  }
  return `exchange-rates?${query}`;
}

function parseGridExchangeRate(response: GridExchangeRatesResponse): GridExchangeRate {
  const entry = response.data[0];
  if (!entry) {
    throw new AppError(
      "PROVIDER_UNAVAILABLE",
      "Lightspark returned no exchange rate for this pair"
    );
  }
  return entry;
}

function normalizeLightsparkPaymentInstruction(
  instruction: GridPaymentInstruction
): LightsparkPaymentRampInstruction {
  const info = instruction.accountOrWalletInfo;
  const baseInstruction: LightsparkProviderPaymentRampInstruction = {
    provider: "lightspark",
    accountOrWalletInfo: {
      accountType: info.accountType,
      accountNumber: info.accountNumber,
      routingNumber: info.routingNumber,
      paymentRails: info.paymentRails,
      reference: info.reference,
      bankName: info.bankName,
    },
    instructionsNotes: instruction.instructionsNotes,
    isPlatformAccount: instruction.isPlatformAccount,
  };

  if (info.accountType.toUpperCase() !== "SOLANA_WALLET") {
    return baseInstruction;
  }
  if (!info.address?.trim()) {
    throw providerUnavailable("Lightspark Solana wallet instruction is missing address.");
  }

  const cryptoCurrency = assertLightsparkInstructionCryptoAsset(info.assetType);
  const destinationAddress = assertValidAddress(
    info.address,
    "Lightspark Solana wallet instruction address"
  );

  return {
    ...baseInstruction,
    kind: "crypto_deposit",
    destinationAddress,
    cryptoCurrency,
    network: "SOLANA",
    reference: info.reference,
    accountOrWalletInfo: {
      ...baseInstruction.accountOrWalletInfo,
      accountType: "SOLANA_WALLET",
      address: destinationAddress,
      assetType: cryptoCurrency,
    },
  };
}

export interface CreateLightsparkOnrampQuoteInput {
  /** Grid customer that will fund the quote in real time. */
  customerId: string;
  /** Grid external account id the crypto will be delivered to (e.g. ExternalAccount:...). */
  destinationAccountId: string;
  /** Source fiat currency code (e.g. USD). */
  fiatCurrency: string;
  /** Destination crypto currency code (e.g. USDC). */
  cryptoCurrency: string;
  /** Locked sending amount in the fiat currency's smallest unit (cents). */
  fiatAmountMinorUnits: number;
  description?: string;
}

export interface LightsparkQuote {
  id: string;
  quoteStatus?: string;
  paymentInstructions?: LightsparkPaymentRampInstruction[];
  exchangeRate?: number;
  totalSendingAmount?: number;
  sendingCurrency: PaymentRampQuoteCurrency;
  totalReceivingAmount?: number;
  receivingCurrency: PaymentRampQuoteCurrency;
  feesIncluded?: number;
  feeCurrency: PaymentRampQuoteCurrency;
  expiresAt?: string;
}

interface LightsparkSupportedCurrency {
  currencyCode?: string;
  enabledTransactionTypes?: string[];
}

interface LightsparkConfigDump {
  embeddedWalletConfig?: { appName?: string };
  supportedCurrencies?: readonly LightsparkSupportedCurrency[];
}

function extractSupport(config: LightsparkConfigDump): ProviderRampSupport {
  const support = createProviderRampSupport();
  const platformIsSolana = config.embeddedWalletConfig?.appName === "Solana";

  for (const entry of config.supportedCurrencies ?? []) {
    const code = entry.currencyCode;
    if (!code) continue;
    const upper = code.toUpperCase();
    const enabled = entry.enabledTransactionTypes ?? [];

    if (isSolanaCryptoAsset(upper)) {
      if (platformIsSolana && enabled.includes("OUTGOING")) {
        support.onrampCryptos.add(SOLANA_ASSET_TO_RAIL[upper]);
        support.offrampCryptos.add(SOLANA_ASSET_TO_RAIL[upper]);
      }
      continue;
    }

    const parsed = parseFiatCurrency(upper);
    if (!parsed) continue;
    if (enabled.includes("INCOMING")) support.onrampFiats.add(parsed);
    if (enabled.includes("OUTGOING")) support.offrampFiats.add(parsed);
  }

  return support;
}

export class LightsparkRampClient implements RampProvider {
  readonly id = "lightspark";

  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return lightsparkCounterpartyRequirements(counterparty, options);
  }

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProvider["_discoverRails"]>[0]) {
    const clientId = requireEnv(env, "LIGHTSPARK_GRID_SANDBOX_CLIENT_ID");
    const clientSecret = requireEnv(env, "LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET");
    const base =
      env.LIGHTSPARK_GRID_API_BASE_URL?.trim() || "https://api.lightspark.com/grid/2025-10-13";
    const headers = {
      Authorization: basicAuthHeader(clientId, clientSecret),
    };

    await writeDump(
      RAMP_RAIL_DUMPS.lightspark.config.name,
      await fetchJson(this.id, "GET /config", `${base}/config`, { headers })
    );
  }

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(
      await readDump<LightsparkConfigDump>(RAMP_RAIL_DUMPS.lightspark.config.file)
    );
  }

  private async request<TResponse, TBody = never>(
    config: LightsparkConfig,
    path: string,
    init: ProviderRequestInit<TBody>
  ): Promise<TResponse> {
    const base = config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
    const url = new URL(path, base);

    return providerFetchJson<TResponse, TBody>(this.id, url.toString(), {
      ...init,
      headers: {
        Authorization: basicAuthHeader(config.tokenId, config.clientSecret),
        ...init.headers,
      },
    });
  }

  /** Creates a native Grid customer for a counterparty (KYC'd buyer). */
  async createCustomer(
    config: LightsparkConfig,
    input: CreateLightsparkCustomerInput
  ): Promise<LightsparkCustomer> {
    const response = await this.request<GridCustomerResponse, GridCreateCustomerBody>(
      config,
      "customers",
      {
        method: "POST",
        body: {
          platformCustomerId: input.platformCustomerId,
          customerType: input.customerType,
          fullName: input.fullName,
          ...(input.email ? { email: input.email } : {}),
        },
      }
    );

    return { id: response.id };
  }

  /** Looks up an existing Grid customer by the platform-side id we assigned. */
  async findCustomerByPlatformId(
    config: LightsparkConfig,
    platformCustomerId: string
  ): Promise<LightsparkCustomer | null> {
    const query = new URLSearchParams({ platformCustomerId, limit: "1" });
    const response = await this.request<GridCustomerListResponse>(
      config,
      `customers?${query.toString()}`,
      { method: "GET" }
    );
    const [existing] = response.data;
    return existing ? { id: existing.id } : null;
  }

  /**
   * Idempotent customer creation keyed on platformCustomerId. Grid rejects a
   * duplicate platformCustomerId with 409; we recover by returning the customer
   * that already exists, so concurrent callers converge instead of orphaning one.
   */
  async getOrCreateCustomer(
    { env, mode }: RampRuntimeContext,
    input: CreateLightsparkCustomerInput
  ): Promise<LightsparkCustomer> {
    const config = readLightsparkConfig(env, mode);
    try {
      return await this.createCustomer(config, input);
    } catch (error) {
      if (error instanceof AppError && error.code === "CONFLICT") {
        const existing = await this.findCustomerByPlatformId(config, input.platformCustomerId);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  /** Creates a just-in-time (real-time funded) onramp quote and locks the FX rate. */
  private async gridOnrampQuote(
    config: LightsparkConfig,
    input: CreateLightsparkOnrampQuoteInput
  ): Promise<LightsparkQuote> {
    const response = await this.request<GridQuoteResponse, GridCreateQuoteBody>(config, "quotes", {
      method: "POST",
      body: {
        source: {
          sourceType: "REALTIME_FUNDING",
          customerId: input.customerId,
          currency: input.fiatCurrency,
        },
        destination: {
          destinationType: "ACCOUNT",
          accountId: input.destinationAccountId,
          currency: input.cryptoCurrency,
        },
        lockedCurrencySide: "SENDING",
        lockedCurrencyAmount: input.fiatAmountMinorUnits,
        description: input.description ?? "SDP onramp",
      },
    });

    return parseLightsparkQuote(response);
  }

  private async findCustomerExternalAccount(
    config: LightsparkConfig,
    customerId: string,
    currency: string,
    predicate: (account: LightsparkExternalAccount) => boolean
  ): Promise<LightsparkExternalAccount | null> {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams();
      query.set("customerId", customerId);
      query.set("currency", currency);
      query.set("limit", "100");
      if (cursor) query.set("cursor", cursor);

      const response = await this.request<{
        data?: unknown;
        hasMore?: unknown;
        nextCursor?: unknown;
      }>(config, `customers/external-accounts?${query}`, { method: "GET" });

      const accounts = Array.isArray(response.data) ? response.data : [];
      for (const accountPayload of accounts) {
        const account = parseLightsparkExternalAccount(accountPayload);
        if (predicate(account)) return account;
      }

      const hasMore = response.hasMore === true;
      cursor =
        typeof response.nextCursor === "string" && response.nextCursor.length > 0
          ? response.nextCursor
          : undefined;
      if (!hasMore || !cursor) break;
    }
    return null;
  }

  private async resolveOnrampDestinationAccountId(
    config: LightsparkConfig,
    customerId: string,
    destinationWallet: string,
    currency: string
  ): Promise<string> {
    const normalized = destinationWallet.trim();
    if (normalized.length === 0) {
      throw badRequest("destinationWallet is required for lightspark");
    }
    if (normalized.includes(":")) {
      return assertLightsparkAccountId(normalized, "destinationWallet");
    }
    if (!isAddress(normalized)) {
      throw new AppError(
        "BAD_REQUEST",
        "destinationWallet must be a Lightspark account id (for example ExternalAccount:...) or a Solana wallet address"
      );
    }

    const existing = await this.findCustomerExternalAccount(
      config,
      customerId,
      currency,
      (account) =>
        Boolean(account.id) &&
        account.accountInfo?.accountType?.toUpperCase() === "SOLANA_WALLET" &&
        account.accountInfo?.address === normalized
    );
    if (existing?.id) return existing.id;

    const createResponse = await this.request<unknown, Record<string, unknown>>(
      config,
      "customers/external-accounts",
      {
        method: "POST",
        body: {
          customerId,
          currency,
          accountInfo: { accountType: "SOLANA_WALLET", address: normalized },
        },
      }
    );
    const created = parseLightsparkExternalAccount(createResponse);
    if (!created.id) {
      throw badRequest("Lightspark external account response is missing id");
    }
    return created.id;
  }

  async estimateOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const config = readLightsparkConfig(env, mode);
    const cryptoCurrency = normalizeLightsparkCurrencyCode(
      getCryptoRailAssetLabel(input.assetRail)
    );
    const corridor = parseGridExchangeRate(
      await this.request<GridExchangeRatesResponse>(
        config,
        gridExchangeRatesPath({
          sourceCurrency: input.fiatCurrency,
          destinationCurrency: cryptoCurrency,
        }),
        { method: "GET" }
      )
    );
    const sendingAmount = toLightsparkMinorUnitsInteger(
      parseDecimalAmount(input.fiatAmount, corridor.sourceCurrency.decimals),
      "fiatAmount"
    );
    const rate = parseGridExchangeRate(
      await this.request<GridExchangeRatesResponse>(
        config,
        gridExchangeRatesPath({
          sourceCurrency: input.fiatCurrency,
          destinationCurrency: cryptoCurrency,
          sendingAmount,
        }),
        { method: "GET" }
      )
    );

    if (rate.receivingAmount <= 0) {
      throw providerUnavailable("Lightspark returned a non-positive on-ramp receiving amount");
    }
    const cryptoAmount = formatDecimalAmount(
      BigInt(rate.receivingAmount),
      rate.destinationCurrency.decimals
    );
    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: input.fiatAmount,
      cryptoAmount,
      exchangeRate: String(Number(input.fiatAmount) / Number(cryptoAmount)),
      fees: {
        currency: input.fiatCurrency,
        total: formatDecimalAmount(BigInt(rate.fees.fixed), rate.sourceCurrency.decimals),
      },
    };
  }

  async estimateOfframp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    const config = readLightsparkConfig(env, mode);
    const cryptoCurrency = normalizeLightsparkCurrencyCode(
      getCryptoRailAssetLabel(input.assetRail)
    );
    const corridor = parseGridExchangeRate(
      await this.request<GridExchangeRatesResponse>(
        config,
        gridExchangeRatesPath({
          sourceCurrency: cryptoCurrency,
          destinationCurrency: input.fiatCurrency,
        }),
        { method: "GET" }
      )
    );
    const sendingAmount = toLightsparkMinorUnitsInteger(
      parseDecimalAmount(input.cryptoAmount, corridor.sourceCurrency.decimals),
      "cryptoAmount"
    );
    const rate = parseGridExchangeRate(
      await this.request<GridExchangeRatesResponse>(
        config,
        gridExchangeRatesPath({
          sourceCurrency: cryptoCurrency,
          destinationCurrency: input.fiatCurrency,
          sendingAmount,
        }),
        { method: "GET" }
      )
    );

    if (rate.receivingAmount <= 0) {
      throw providerUnavailable("Lightspark returned a non-positive off-ramp receiving amount");
    }
    const fiatAmount = formatDecimalAmount(
      BigInt(rate.receivingAmount),
      rate.destinationCurrency.decimals
    );
    return {
      provider: this.id,
      direction: "offramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount,
      cryptoAmount: input.cryptoAmount,
      exchangeRate: String(Number(fiatAmount) / Number(input.cryptoAmount)),
      fees: {
        currency: getCryptoRailAssetLabel(input.assetRail),
        total: formatDecimalAmount(BigInt(rate.fees.fixed), rate.sourceCurrency.decimals),
      },
    };
  }

  async createOnrampQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    if (!input.customerId) {
      throw badRequest("Lightspark on-ramp requires a resolved customerId");
    }
    const config = readLightsparkConfig(env, mode);
    const cryptoCurrency = normalizeLightsparkCurrencyCode(input.cryptoToken);
    const fiatCurrency = input.fiatCurrency ?? "USD";
    const fiatAmountMinorUnits = toLightsparkMinorUnitsInteger(
      parseDecimalAmount(input.fiatAmount, 2),
      "fiatAmount"
    );
    const destinationAccountId = await this.resolveOnrampDestinationAccountId(
      config,
      input.customerId,
      input.destinationWalletAddress,
      cryptoCurrency
    );

    const quote = await this.gridOnrampQuote(config, {
      customerId: input.customerId,
      destinationAccountId,
      fiatCurrency,
      cryptoCurrency,
      fiatAmountMinorUnits,
    });

    return this.toRampQuote(quote);
  }

  private toRampQuote(quote: LightsparkQuote): PaymentRampQuote {
    return {
      provider: "lightspark",
      id: quote.id,
      status: mapLightsparkQuoteStatus(quote.quoteStatus),
      deliveryMode: "manual_instructions",
      paymentInstructions: quote.paymentInstructions,
      exchangeRate: quote.exchangeRate,
      totalSendingAmount: quote.totalSendingAmount,
      sendingCurrency: quote.sendingCurrency,
      totalReceivingAmount: quote.totalReceivingAmount,
      receivingCurrency: quote.receivingCurrency,
      feesIncluded: quote.feesIncluded,
      feeCurrency: quote.feeCurrency,
      expiresAt: quote.expiresAt,
    };
  }

  /** Creates a fiat external payout account for a Grid customer. */
  async createFiatExternalAccount(
    { env, mode }: RampRuntimeContext,
    input: {
      customerId: string;
      currency: string;
      platformAccountId: string;
      accountInfo: Record<string, unknown>;
    }
  ): Promise<LightsparkExternalAccountResolution> {
    const config = readLightsparkConfig(env, mode);
    const response = await this.request<unknown, Record<string, unknown>>(
      config,
      "customers/external-accounts",
      {
        method: "POST",
        body: {
          customerId: input.customerId,
          currency: input.currency,
          platformAccountId: input.platformAccountId,
          accountInfo: input.accountInfo,
        },
      }
    );
    return parseLightsparkExternalAccountResolution(response);
  }

  /**
   * Idempotent payout-account creation keyed on platformAccountId. Grid rejects
   * a duplicate with 409 ("External account already exists"); we recover by
   * returning the account that already carries our id, so concurrent callers
   * converge instead of orphaning one.
   */
  async getOrCreateFiatExternalAccount(
    ctx: RampRuntimeContext,
    input: {
      customerId: string;
      currency: string;
      platformAccountId: string;
      accountInfo: Record<string, unknown>;
    }
  ): Promise<LightsparkExternalAccountResolution> {
    try {
      return await this.createFiatExternalAccount(ctx, input);
    } catch (error) {
      if (error instanceof AppError && error.code === "CONFLICT") {
        const config = readLightsparkConfig(ctx.env, ctx.mode);
        const existing = await this.findCustomerExternalAccount(
          config,
          input.customerId,
          input.currency,
          (account) => account.platformAccountId === input.platformAccountId
        );
        if (existing?.id && existing.status) {
          return { id: existing.id, status: existing.status };
        }
      }
      throw error;
    }
  }

  async getExternalAccount(
    { env, mode }: RampRuntimeContext,
    input: { accountId: string }
  ): Promise<LightsparkExternalAccountResolution> {
    const config = readLightsparkConfig(env, mode);
    const response = await this.request<unknown>(
      config,
      `customers/external-accounts/${encodeURIComponent(input.accountId)}`,
      { method: "GET" }
    );
    return parseLightsparkExternalAccountResolution(response);
  }

  /**
   * Creates a just-in-time (real-time funded) off-ramp quote: the customer
   * funds it by sending crypto to the returned payment instructions, and Grid
   * auto-executes into the fiat payout account at the locked rate.
   */
  async createOfframpQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    if (!input.customerId) {
      throw badRequest("Lightspark off-ramp requires a resolved customerId");
    }
    if (!input.payoutAccountId) {
      throw badRequest("Lightspark off-ramp requires a resolved payoutAccountId");
    }
    if (!input.fiatCurrency) {
      throw badRequest("fiatCurrency is required for Lightspark off-ramp.");
    }
    const config = readLightsparkConfig(env, mode);
    const cryptoCurrency = normalizeLightsparkCurrencyCode(input.cryptoToken);
    if (!isSolanaCryptoAsset(cryptoCurrency)) {
      throw badRequest(
        `Lightspark off-ramp from an SDP wallet supports Solana assets only; got ${cryptoCurrency}.`
      );
    }
    const cryptoAmountMinorUnits = toLightsparkMinorUnitsInteger(
      parseDecimalAmount(input.cryptoAmount, getLightsparkCurrencyDecimals(cryptoCurrency)),
      "cryptoAmount"
    );

    const response = await this.request<GridQuoteResponse, GridCreateQuoteBody>(config, "quotes", {
      method: "POST",
      body: {
        source: {
          sourceType: "REALTIME_FUNDING",
          customerId: input.customerId,
          currency: cryptoCurrency,
          cryptoNetwork: "SOLANA",
        },
        destination: {
          destinationType: "ACCOUNT",
          accountId: input.payoutAccountId,
          currency: input.fiatCurrency,
        },
        lockedCurrencySide: "SENDING",
        lockedCurrencyAmount: cryptoAmountMinorUnits,
        description: "SDP offramp",
      },
    });

    return this.toRampQuote(parseLightsparkQuote(response));
  }

  async sandboxSend({ env, mode }: RampRuntimeContext, payload: unknown): Promise<unknown> {
    return this.request<unknown, unknown>(readLightsparkConfig(env, mode), "sandbox/send", {
      method: "POST",
      body: payload,
    });
  }
}

function parseLightsparkQuote(raw: GridQuoteResponse): LightsparkQuote {
  return {
    id: raw.id,
    quoteStatus: raw.quoteStatus,
    paymentInstructions: raw.paymentInstructions?.map(normalizeLightsparkPaymentInstruction),
    exchangeRate: raw.exchangeRate,
    totalSendingAmount: raw.totalSendingAmount,
    sendingCurrency: raw.sendingCurrency,
    totalReceivingAmount: raw.totalReceivingAmount,
    receivingCurrency: raw.receivingCurrency,
    feesIncluded: raw.feesIncluded,
    feeCurrency: raw.sendingCurrency,
    expiresAt: raw.expiresAt,
  };
}
