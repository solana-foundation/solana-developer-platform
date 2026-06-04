import { createVerify } from "node:crypto";
import type {
  LightsparkPaymentRampInstruction,
  PaymentRampExecution,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import { parseFiatCurrency } from "@sdp/types/payment-rails";
import { parseDecimalAmount } from "@/lib/amount";
import { AppError, providerNotConfigured } from "@/lib/errors";
import { isAddress } from "@/lib/solana";
import { type ProviderRequestInit, providerFetchJson } from "../fetch";
import {
  basicAuthHeader,
  createProviderRampSupport,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  rampId,
  requireEnv,
  SOLANA_ASSET_TO_RAIL,
} from "../shared";
import type {
  ProviderRampSupport,
  RampDumpReader,
  RampExecuteOfframpInput,
  RampExecuteOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampRuntimeContext,
  RampWebhookValidationContext,
  RampWebhookValidationResult,
} from "../types";

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
    throw new AppError("BAD_REQUEST", "cryptoToken must be a valid Lightspark currency code");
  }
  return normalized;
}

function getLightsparkCurrencyDecimals(currencyCode: string): number {
  const normalized = currencyCode.trim().toUpperCase();
  if (normalized === "BTC") return 8;
  if (normalized === "SOL") return 9;
  if (normalized === "USDC") return 6;
  throw new AppError(
    "BAD_REQUEST",
    `Unsupported lightspark cryptoToken: ${currencyCode}. Supported values: BTC, SOL, USDC`
  );
}

function assertLightsparkAccountId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AppError("BAD_REQUEST", `${fieldName} is required for lightspark`);
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
    throw new AppError("BAD_REQUEST", `${fieldName} is too large for Lightspark quote minor units`);
  }
  return Number(value);
}

function mapLightsparkQuoteStatus(status: string | undefined): PaymentRampExecution["status"] {
  if (!status) return "pending";
  const normalized = status.trim().toUpperCase();
  if (normalized === "COMPLETED") return "completed";
  if (normalized === "PROCESSING") return "processing";
  if (normalized === "FAILED" || normalized === "EXPIRED") return "failed";
  return "pending";
}

interface LightsparkExternalAccount {
  id?: string;
  accountInfo?: { accountType?: string; address?: string };
}

function parseLightsparkExternalAccount(payload: unknown): LightsparkExternalAccount {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }
  const raw = payload as {
    id?: unknown;
    accountInfo?: { accountType?: unknown; address?: unknown };
  };
  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
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
  accountOrWalletInfo: LightsparkPaymentRampInstruction["accountOrWalletInfo"];
  instructionsNotes?: string;
  isPlatformAccount?: boolean;
}

interface GridQuoteResponse {
  id: string;
  quoteStatus?: string;
  paymentInstructions?: GridPaymentInstruction[];
  exchangeRate: number;
  totalSendingAmount: number;
  totalReceivingAmount: number;
  feesIncluded: number;
  expiresAt: string;
}

interface GridOfframpQuoteBody {
  source: { sourceType: "ACCOUNT"; accountId: string; currency: string };
  destination: { destinationType: "ACCOUNT"; accountId: string; currency: string };
  lockedCurrencySide: "SENDING" | "RECEIVING";
  lockedCurrencyAmount: number;
  description: string;
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
  totalReceivingAmount?: number;
  feesIncluded?: number;
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

  /**
   * Verifies a Grid webhook via the `X-Grid-Signature` header: an ECDSA P-256 /
   * SHA-256 signature over the raw request body, checked against the Grid
   * webhook public key (PEM/SPKI). The header is JSON `{"v":1,"s":"<base64>"}`.
   */
  async validateWebhook({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<RampWebhookValidationResult> {
    const publicKey = requireEnv(
      env,
      environment === "sandbox"
        ? "LIGHTSPARK_GRID_SANDBOX_WEBHOOK_PUBLIC_KEY"
        : "LIGHTSPARK_GRID_WEBHOOK_PUBLIC_KEY"
    );

    const signatureHeader = headers.get("x-grid-signature")?.trim();
    if (!signatureHeader) {
      throw new AppError("UNAUTHORIZED", "Lightspark webhook is missing x-grid-signature", {
        provider: this.id,
      });
    }

    // Grid sends `{"v":1,"s":"<base64 DER ECDSA>"}`; fall back to bare base64.
    let signatureB64 = signatureHeader;
    try {
      const parsed = JSON.parse(signatureHeader) as { s?: unknown };
      if (parsed && typeof parsed.s === "string") {
        signatureB64 = parsed.s;
      }
    } catch {
      // Not JSON — treat the header value as bare base64.
    }

    const verified = createVerify("SHA256")
      .update(rawBody)
      .verify(
        // Doppler may store the PEM with literal "\n"; normalize to real newlines.
        { key: publicKey.replace(/\\n/g, "\n"), format: "pem", type: "spki" },
        Buffer.from(signatureB64, "base64")
      );
    if (!verified) {
      throw new AppError("UNAUTHORIZED", "Invalid Lightspark webhook signature", {
        provider: this.id,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new AppError("BAD_REQUEST", "Lightspark webhook body must be valid JSON", {
        provider: this.id,
      });
    }

    return { provider: this.id, payload };
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
      throw new AppError("BAD_REQUEST", "destinationWallet is required for lightspark");
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
      throw new AppError("BAD_REQUEST", "Lightspark external account response is missing id");
    }
    return created.id;
  }

  async createOnrampQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    if (!input.customerId) {
      throw new AppError("BAD_REQUEST", "Lightspark on-ramp requires a resolved customerId");
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

    return {
      provider: "lightspark",
      id: quote.id,
      status: mapLightsparkQuoteStatus(quote.quoteStatus),
      deliveryMode: "manual_instructions",
      paymentInstructions: quote.paymentInstructions,
      exchangeRate: quote.exchangeRate,
      totalSendingAmount: quote.totalSendingAmount,
      totalReceivingAmount: quote.totalReceivingAmount,
      feesIncluded: quote.feesIncluded,
      expiresAt: quote.expiresAt,
    };
  }

  async createOfframpQuote(
    _ctx: RampRuntimeContext,
    _input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    throw new AppError(
      "BAD_REQUEST",
      "Lightspark off-ramp quotes require payout bank details, which aren't collected yet."
    );
  }

  async executeOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampExecuteOnrampInput
  ): Promise<PaymentRampExecution> {
    const customerId = input.kycReference?.trim();
    if (!customerId) {
      throw new AppError(
        "BAD_REQUEST",
        "kycReference is required for lightspark onramp and must contain a Lightspark customer id"
      );
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
      customerId,
      input.destinationWalletAddress,
      cryptoCurrency
    );

    const quote = await this.gridOnrampQuote(config, {
      customerId,
      destinationAccountId,
      fiatCurrency,
      cryptoCurrency,
      fiatAmountMinorUnits,
    });

    return {
      id: rampId("ramp"),
      provider: "lightspark",
      status: mapLightsparkQuoteStatus(quote.quoteStatus),
      paymentInstructions: quote.paymentInstructions,
      reference: quote.id,
    };
  }

  async executeOfframp(
    { env, mode }: RampRuntimeContext,
    input: RampExecuteOfframpInput
  ): Promise<PaymentRampExecution> {
    const sourceAccountId = assertLightsparkAccountId(input.sourceWalletAddress, "sourceWallet");
    const destinationAccountId = assertLightsparkAccountId(
      input.kycReference ?? "",
      "kycReference"
    );
    const cryptoCurrency = normalizeLightsparkCurrencyCode(input.cryptoToken);
    const fiatCurrency = input.fiatCurrency ?? "USD";
    const cryptoAmountMinorUnits = toLightsparkMinorUnitsInteger(
      parseDecimalAmount(input.cryptoAmount, getLightsparkCurrencyDecimals(cryptoCurrency)),
      "cryptoAmount"
    );
    const config = readLightsparkConfig(env, mode);

    const quoteResponse = await this.request<GridQuoteResponse, GridOfframpQuoteBody>(
      config,
      "quotes",
      {
        method: "POST",
        body: {
          source: { sourceType: "ACCOUNT", accountId: sourceAccountId, currency: cryptoCurrency },
          destination: {
            destinationType: "ACCOUNT",
            accountId: destinationAccountId,
            currency: fiatCurrency,
          },
          lockedCurrencySide: "SENDING",
          lockedCurrencyAmount: cryptoAmountMinorUnits,
          description: "SDP offramp",
        },
      }
    );
    const quote = parseLightsparkQuote(quoteResponse);

    const executedResponse = await this.request<GridQuoteResponse>(
      config,
      `quotes/${encodeURIComponent(quote.id)}/execute`,
      { method: "POST" }
    );
    const executedQuote = parseLightsparkQuote(executedResponse);

    return {
      id: rampId("ramp"),
      provider: "lightspark",
      status: mapLightsparkQuoteStatus(executedQuote.quoteStatus),
      paymentInstructions: executedQuote.paymentInstructions,
      reference: quote.id,
    };
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
    paymentInstructions: raw.paymentInstructions?.map((instruction) => ({
      provider: "lightspark" as const,
      ...instruction,
    })),
    exchangeRate: raw.exchangeRate,
    totalSendingAmount: raw.totalSendingAmount,
    totalReceivingAmount: raw.totalReceivingAmount,
    feesIncluded: raw.feesIncluded,
    expiresAt: raw.expiresAt,
  };
}
