import type {
  Counterparty,
  CounterpartyProviderData,
  LightsparkGridAmount,
  LightsparkPaymentRampExecution,
  LightsparkPaymentRampInstruction,
  LightsparkRampSettlement,
  PaymentRampEstimate,
  PaymentRampExecution,
  PaymentRampQuote,
  PaymentRampQuoteCurrency,
  SdpEnvironment,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import {
  CRYPTO_ASSET_DECIMALS,
  type CryptoAssetSymbol,
  getCryptoRailAssetLabel,
  parseFiatCurrency,
} from "@sdp/types/payment-rails";
import type { CollectedFieldData, CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { formatDecimalAmount, parseDecimalAmount } from "@/lib/amount";
import { AppError, badRequest, providerNotConfigured, providerUnavailable } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import { isAddress } from "@/lib/solana";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
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
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampRuntimeContext,
  RampSettlementEvent,
  RampWebhookValidationContext,
  RampWebhookValidationResult,
  ValidateCounterpartyOptions,
} from "../types";
import { lightsparkCounterpartyRequirements } from "../validation/lightspark";

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

function isCryptoAssetSymbol(value: string): value is CryptoAssetSymbol {
  return value in CRYPTO_ASSET_DECIMALS;
}

function getLightsparkCurrencyDecimals(currencyCode: string): number {
  const normalized = currencyCode.trim().toUpperCase();
  if (normalized === "BTC") return 8;
  if (isCryptoAssetSymbol(normalized)) return CRYPTO_ASSET_DECIMALS[normalized];
  throw new AppError(
    "BAD_REQUEST",
    `Unsupported lightspark cryptoToken: ${currencyCode}. Supported values: BTC, ${Object.keys(CRYPTO_ASSET_DECIMALS).join(", ")}`
  );
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

function mapLightsparkQuoteStatus(status: string | undefined): PaymentRampExecution["status"] {
  if (!status) return "pending";
  const normalized = status.trim().toUpperCase();
  if (normalized === "COMPLETED") return "completed";
  if (normalized === "PROCESSING") return "processing";
  if (normalized === "FAILED" || normalized === "EXPIRED") return "failed";
  return "pending";
}

const LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES = {
  "OUTGOING_PAYMENT.PENDING": "awaiting_payment",
  "OUTGOING_PAYMENT.PROCESSING": "settling",
  "OUTGOING_PAYMENT.COMPLETED": "settled",
  "OUTGOING_PAYMENT.FAILED": "failed",
  "OUTGOING_PAYMENT.EXPIRED": "expired",
  "OUTGOING_PAYMENT.REFUND_FAILED": "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

type LightsparkOutgoingPaymentWebhookType = keyof typeof LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES;

interface LightsparkOutgoingPaymentData {
  id: string;
  status: string;
  quoteId: string;
  failureReason?: string;
  sentAmount?: LightsparkGridAmount;
  receivedAmount?: LightsparkGridAmount;
  exchangeRate?: number;
  fees?: number;
}

function readOptionalGridAmount(
  record: Record<string, unknown>,
  field: string
): LightsparkGridAmount | undefined {
  const value = record[field];
  if (!isGridRecord(value)) {
    return undefined;
  }
  const amount = value.amount;
  const currency = value.currency;
  if (!Number.isInteger(amount) || typeof amount !== "number" || !isGridRecord(currency)) {
    return undefined;
  }
  const decimals = currency.decimals;
  const currencyCode = currency.code;
  if (
    !Number.isInteger(decimals) ||
    typeof decimals !== "number" ||
    typeof currencyCode !== "string"
  ) {
    return undefined;
  }
  return { amount, currencyCode: currencyCode.toUpperCase(), decimals };
}

function readOptionalGridNumber(
  record: Record<string, unknown>,
  field: string
): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isLightsparkTerminalStatus(status: string): status is LightsparkRampSettlement["status"] {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "EXPIRED" ||
    status === "REFUND_FAILED"
  );
}

function buildLightsparkSettlement(
  data: LightsparkOutgoingPaymentData
): LightsparkRampSettlement | undefined {
  const { status, sentAmount, receivedAmount, exchangeRate, fees, failureReason } = data;
  if (
    !isLightsparkTerminalStatus(status) ||
    !sentAmount ||
    !receivedAmount ||
    exchangeRate === undefined ||
    fees === undefined
  ) {
    return undefined;
  }
  return {
    provider: "lightspark",
    status,
    sentAmount,
    receivedAmount,
    exchangeRate,
    fees,
    ...(failureReason ? { failureReason } : {}),
  };
}

interface LightsparkOutgoingPaymentWebhook {
  type: LightsparkOutgoingPaymentWebhookType;
  data: LightsparkOutgoingPaymentData;
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

function readOptionalGridString(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = record[field];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

function readRequiredGridObject(
  record: Record<string, unknown>,
  field: string,
  payloadName: string
): Record<string, unknown> {
  const value = record[field];
  if (!isGridRecord(value)) {
    throw badRequest(`${payloadName} is missing ${field}`);
  }
  return value;
}

function isLightsparkOutgoingPaymentWebhookType(
  value: string
): value is LightsparkOutgoingPaymentWebhookType {
  return Object.hasOwn(LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES, value);
}

function parseLightsparkOutgoingPaymentWebhook(
  payload: unknown
): LightsparkOutgoingPaymentWebhook | null {
  if (!isGridRecord(payload)) {
    throw badRequest("Lightspark webhook body must be an object");
  }

  const type = readRequiredGridString(payload, "type", "Lightspark webhook");
  if (!isLightsparkOutgoingPaymentWebhookType(type)) {
    return null;
  }

  const data = readRequiredGridObject(payload, "data", "Lightspark webhook");
  return {
    type,
    data: {
      id: readRequiredGridString(data, "id", "Lightspark outgoing payment webhook data"),
      status: readRequiredGridString(data, "status", "Lightspark outgoing payment webhook data"),
      quoteId: readRequiredGridString(data, "quoteId", "Lightspark outgoing payment webhook data"),
      failureReason: readOptionalGridString(data, "failureReason"),
      sentAmount: readOptionalGridAmount(data, "sentAmount"),
      receivedAmount: readOptionalGridAmount(data, "receivedAmount"),
      exchangeRate: readOptionalGridNumber(data, "exchangeRate"),
      fees: readOptionalGridNumber(data, "fees"),
    },
  };
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

export interface LightsparkPayoutAccount {
  accountId: string;
  status: string;
}

export interface LightsparkPayoutAccountEntry extends LightsparkPayoutAccount {
  /** `${fiatCurrency}:${hash(accountInfo)}` — content-addressed so distinct bank details map to distinct Grid accounts. */
  key: string;
  createdAt: string;
}

export function isLightsparkExternalAccountActive(status: string): boolean {
  return status.trim().toUpperCase() === "ACTIVE";
}

/** Cache key for a payout account: same collected details always map to the same key, distinct details never collide. */
export async function lightsparkPayoutAccountKey(
  fiatCurrency: string,
  collectedData: CollectedFieldData
): Promise<string> {
  const fields = Object.entries(collectedData)
    .map(([key, value]) => `${key}=${value.trim()}`)
    .sort()
    .join("&");
  return `${fiatCurrency}:${(await hashString(fields)).slice(0, 16)}`;
}

export function readLightsparkData(
  providerData: CounterpartyProviderData
): Record<string, unknown> {
  const lightspark = providerData.lightspark;
  return lightspark && typeof lightspark === "object"
    ? (lightspark as Record<string, unknown>)
    : {};
}

export function readLightsparkCustomerId(providerData: CounterpartyProviderData): string | null {
  const customerId = readLightsparkData(providerData).customerId;
  return typeof customerId === "string" && customerId.length > 0 ? customerId : null;
}

export function readLightsparkPayoutAccounts(
  providerData: CounterpartyProviderData
): Record<string, unknown> {
  const payoutAccounts = readLightsparkData(providerData).payoutAccounts;
  return payoutAccounts && typeof payoutAccounts === "object"
    ? (payoutAccounts as Record<string, unknown>)
    : {};
}

function parseLightsparkPayoutAccountEntry(
  key: string,
  value: unknown
): LightsparkPayoutAccountEntry {
  const { accountId, status, createdAt } = value as {
    accountId?: unknown;
    status?: unknown;
    createdAt?: unknown;
  };
  if (
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    typeof status !== "string" ||
    typeof createdAt !== "string"
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      `Malformed lightspark payout account entry "${key}" in provider_data`
    );
  }
  return { key, accountId, status, createdAt };
}

export function readLightsparkPayoutAccountByKey(
  providerData: CounterpartyProviderData,
  key: string
): LightsparkPayoutAccountEntry | null {
  const value = readLightsparkPayoutAccounts(providerData)[key];
  if (value === undefined) {
    return null;
  }
  return parseLightsparkPayoutAccountEntry(key, value);
}

export function latestLightsparkPayoutAccount(
  providerData: CounterpartyProviderData,
  fiatCurrency: string
): LightsparkPayoutAccountEntry | null {
  const entries = Object.entries(readLightsparkPayoutAccounts(providerData))
    .filter(([key]) => key.startsWith(`${fiatCurrency}:`))
    .map(([key, value]) => parseLightsparkPayoutAccountEntry(key, value))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries[0] ?? null;
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

export interface LightsparkExecuteOnrampInput {
  destinationWalletAddress: string;
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  fiatAmount: string;
  providerCustomer: LightsparkCustomerResolution;
}

export interface LightsparkExecuteOfframpInput {
  sourceWalletAddress: string;
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  cryptoAmount: string;
  providerCustomer: LightsparkCustomerResolution;
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
  accountOrWalletInfo: LightsparkPaymentRampInstruction["accountOrWalletInfo"];
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

interface GridOfframpQuoteBody {
  source: { sourceType: "ACCOUNT"; accountId: string; currency: string };
  destination: { destinationType: "ACCOUNT"; accountId: string; currency: string };
  lockedCurrencySide: "SENDING" | "RECEIVING";
  lockedCurrencyAmount: number;
  description: string;
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

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw badRequest("Lightspark webhook body must be valid JSON", {
        provider: this.id,
      });
    }

    const timestamp = payload.timestamp;
    await verifyWebhookSignature({
      provider: this.id,
      signedPayload: rawBody,
      signature: signatureB64,
      algorithm: { type: "ecdsa-sha256", publicKeyPem: publicKey },
      timestampSeconds: typeof timestamp === "string" ? Date.parse(timestamp) / 1000 : Number.NaN,
    });

    return { provider: this.id, payload };
  }

  parseSettlementEvent(payload: unknown): RampSettlementEvent {
    const webhook = parseLightsparkOutgoingPaymentWebhook(payload);
    if (!webhook) {
      return { provider: this.id, kind: "ignore", reason: "unsupported_event" };
    }

    const reference = webhook.data.quoteId;
    if (!reference) {
      return { provider: this.id, kind: "ignore", reason: "missing_quote_id" };
    }

    const kind = LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES[webhook.type];
    const settlement = buildLightsparkSettlement(webhook.data);
    if (kind === "failed" || kind === "expired") {
      return {
        provider: this.id,
        kind,
        reference,
        ...(webhook.data.failureReason ? { error: webhook.data.failureReason } : {}),
        ...(settlement ? { settlement } : {}),
      };
    }
    if (kind === "settled" && webhook.data.receivedAmount) {
      return {
        provider: this.id,
        kind,
        reference,
        receivedAmount: formatDecimalAmount(
          BigInt(webhook.data.receivedAmount.amount),
          webhook.data.receivedAmount.decimals
        ),
        ...(settlement ? { settlement } : {}),
      };
    }
    return { provider: this.id, kind, reference };
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

  async executeOnramp(
    { env, mode }: RampRuntimeContext,
    input: LightsparkExecuteOnrampInput
  ): Promise<LightsparkPaymentRampExecution> {
    const customerId = input.providerCustomer.customerId;
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
    input: LightsparkExecuteOfframpInput
  ): Promise<LightsparkPaymentRampExecution> {
    const sourceAccountId = assertLightsparkAccountId(input.sourceWalletAddress, "sourceWallet");
    const destinationAccountId = assertLightsparkAccountId(
      input.providerCustomer.customerId,
      "providerCustomer.customerId"
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
    sendingCurrency: raw.sendingCurrency,
    totalReceivingAmount: raw.totalReceivingAmount,
    receivingCurrency: raw.receivingCurrency,
    feesIncluded: raw.feesIncluded,
    feeCurrency: raw.sendingCurrency,
    expiresAt: raw.expiresAt,
  };
}
