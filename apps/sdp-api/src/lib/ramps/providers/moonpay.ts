import type {
  Counterparty,
  MoonpayRampSettlement,
  PaymentRampEstimate,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import {
  type CryptoRailId,
  getCryptoRailAssetLabel,
  parseFiatCurrency,
} from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { AppError, badRequest, providerNotConfigured } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { providerFetchJson } from "../fetch";
import { readyCounterparty } from "../requirements";
import { createProviderRampSupport, RAMP_RAIL_DUMPS, rampId, requireEnv } from "../shared";
import type {
  MutableProviderRampSupport,
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

const MOONPAY_API_BASE_URL = "https://api.moonpay.com";
const MOONPAY_ONRAMP_URL = "https://buy.moonpay.com";
const MOONPAY_OFFRAMP_URL = "https://sell.moonpay.com";
const MOONPAY_SANDBOX_ONRAMP_URL = "https://buy-sandbox.moonpay.com";
const MOONPAY_SANDBOX_OFFRAMP_URL = "https://sell-sandbox.moonpay.com";
const MOONPAY_ONRAMP_MIN_USD = 20;

interface MoonpayConfig {
  apiKey: string;
  secretKey: string;
  onrampUrl: string;
  offrampUrl: string;
}

interface MoonpayBuyQuoteResponse {
  baseCurrencyAmount: number;
  quoteCurrencyAmount: number;
  quoteCurrencyPrice: number;
  feeAmount: number;
  networkFeeAmount: number;
  extraFeeAmount: number;
}

interface MoonpaySellQuoteResponse {
  baseCurrencyAmount: number;
  quoteCurrencyAmount: number;
  baseCurrencyPrice: number;
  feeAmount: number;
  extraFeeAmount: number;
}

function readMoonpayConfig(
  env: Record<string, string | undefined>,
  mode: SdpEnvironment
): MoonpayConfig {
  const apiKey = (mode === "sandbox" ? env.MOONPAY_SANDBOX_API_KEY : env.MOONPAY_API_KEY)?.trim();
  const secretKey = (
    mode === "sandbox" ? env.MOONPAY_SANDBOX_SECRET_KEY : env.MOONPAY_SECRET_KEY
  )?.trim();

  if (!apiKey || !secretKey) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "MoonPay sandbox is not configured. Set MOONPAY_SANDBOX_API_KEY and MOONPAY_SANDBOX_SECRET_KEY."
        : "MoonPay is not configured. Set MOONPAY_API_KEY and MOONPAY_SECRET_KEY."
    );
  }

  const onrampUrl =
    env.MOONPAY_ONRAMP_URL ??
    (mode === "sandbox" ? MOONPAY_SANDBOX_ONRAMP_URL : MOONPAY_ONRAMP_URL);
  const offrampUrl =
    env.MOONPAY_OFFRAMP_URL ??
    (mode === "sandbox" ? MOONPAY_SANDBOX_OFFRAMP_URL : MOONPAY_OFFRAMP_URL);

  try {
    new URL(onrampUrl);
    new URL(offrampUrl);
  } catch {
    throw new AppError("INTERNAL_ERROR", "MoonPay URL configuration is invalid.");
  }

  return { apiKey, secretKey, onrampUrl, offrampUrl };
}

function normalizeMoonpayCurrencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(normalized)) {
    throw new AppError(
      "BAD_REQUEST",
      "cryptoToken must be a valid token symbol or MoonPay currency code"
    );
  }
  if (normalized === "USDC") return "usdc_sol";
  if (normalized === "USDT") return "usdt_sol";
  if (normalized.endsWith("_SOLANA")) {
    return `${normalized.slice(0, -"_SOLANA".length)}_SOL`.toLowerCase();
  }
  return normalized.toLowerCase();
}

function readMoonpayWebhookKey(
  env: Record<string, string | undefined>,
  environment: SdpEnvironment
): string {
  const webhookKey = (
    environment === "sandbox" ? env.MOONPAY_SANDBOX_WEBHOOK_KEY : env.MOONPAY_WEBHOOK_KEY
  )?.trim();
  if (!webhookKey) {
    throw providerNotConfigured(
      environment === "sandbox"
        ? "MoonPay sandbox webhook key is not configured (MOONPAY_SANDBOX_WEBHOOK_KEY)."
        : "MoonPay webhook key is not configured (MOONPAY_WEBHOOK_KEY)."
    );
  }
  return webhookKey;
}

function parseMoonpaySignatureV2Header(
  header: string
): { timestamp: string; signature: string } | null {
  let timestamp: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const prefix = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (prefix === "t") {
      timestamp = value;
    }
    if (prefix === "s") {
      signature = value;
    }
  }

  if (!timestamp || !signature) {
    return null;
  }

  return { timestamp, signature };
}

async function moonpaySignature(unsignedQuery: string, secretKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(unsignedQuery));
  return Buffer.from(signature).toString("base64");
}

async function buildSignedMoonpayWidgetUrl(
  baseUrl: string,
  secretKey: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const url = new URL(baseUrl);
  const sortedEntries = Object.entries(params).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of sortedEntries) {
    if (!value) continue;
    url.searchParams.set(key, value);
  }
  const signature = await moonpaySignature(url.search, secretKey);
  url.searchParams.set("signature", signature);
  return url.toString();
}

const MOONPAY_CRYPTO_CODES = ["sol", "usdc_sol", "usdt_sol", "usdg_sol", "pyusd_sol"] as const;
type MoonpayCryptoCode = (typeof MOONPAY_CRYPTO_CODES)[number];

const MOONPAY_CRYPTO_CODE_TO_RAIL = {
  sol: "sol.solana",
  usdc_sol: "usdc.solana",
  usdt_sol: "usdt.solana",
  usdg_sol: "usdg.solana",
  pyusd_sol: "pyusd.solana",
} as const satisfies Record<MoonpayCryptoCode, CryptoRailId>;

function isMoonpayCryptoCode(value: string): value is MoonpayCryptoCode {
  return (MOONPAY_CRYPTO_CODES as readonly string[]).includes(value);
}

interface MoonpayCurrencyEntry {
  type?: string;
  code?: string;
  isSuspended?: boolean;
  isSellSupported?: boolean;
  supportsTestMode?: boolean;
  minBuyAmount?: number | null;
  minSellAmount?: number | null;
  metadata?: { networkCode?: string };
}

function addFiatSupport(
  entry: MoonpayCurrencyEntry,
  support: Pick<MutableProviderRampSupport, "onrampFiats" | "offrampFiats">
) {
  if (!entry.code) return;
  const parsed = parseFiatCurrency(entry.code);
  if (!parsed) {
    console.warn(`  [moonpay] unknown fiat code: ${entry.code}`);
    return;
  }
  if (entry.minBuyAmount != null) support.onrampFiats.add(parsed);
  if (entry.isSellSupported === true) support.offrampFiats.add(parsed);
}

function addCryptoSupport(
  entry: MoonpayCurrencyEntry,
  support: Pick<MutableProviderRampSupport, "onrampCryptos" | "offrampCryptos">
) {
  if (!entry.code) return;
  if (entry.isSuspended === true) return;
  if (entry.supportsTestMode !== true) return;
  if (entry.metadata?.networkCode !== "solana") return;
  if (!isMoonpayCryptoCode(entry.code)) return;

  const rail = MOONPAY_CRYPTO_CODE_TO_RAIL[entry.code];
  if (entry.minBuyAmount != null) support.onrampCryptos.add(rail);
  if (entry.isSellSupported === true && entry.minSellAmount != null) {
    support.offrampCryptos.add(rail);
  }
}

function extractSupport(currencies: readonly MoonpayCurrencyEntry[]): ProviderRampSupport {
  const support = createProviderRampSupport();

  for (const entry of currencies) {
    if (entry.type === "fiat") addFiatSupport(entry, support);
    if (entry.type === "crypto") addCryptoSupport(entry, support);
  }

  return support;
}

const MOONPAY_TRANSACTION_STATUS = {
  waitingPayment: "awaiting_payment",
  pending: "settling",
  waitingAuthorization: "settling",
  completed: "settled",
  failed: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;
type MoonpayTransactionStatus = keyof typeof MOONPAY_TRANSACTION_STATUS;

interface MoonpayTransactionWebhook {
  type: "transaction_created" | "transaction_updated" | "transaction_failed";
  data: {
    id: string;
    status: MoonpayTransactionStatus;
    externalTransactionId: string | null;
    failureReason: string | null;
    baseCurrencyAmount?: number;
    quoteCurrencyAmount?: number;
    feeAmount?: number;
    extraFeeAmount?: number;
    networkFeeAmount?: number;
    areFeesIncluded?: boolean;
    usdRate?: number;
    cryptoTransactionId?: string | null;
    baseCurrency?: { code: string };
    currency?: { code: string };
  };
}

function buildMoonpaySettlement(
  data: MoonpayTransactionWebhook["data"],
  status: MoonpayRampSettlement["status"]
): MoonpayRampSettlement | undefined {
  const {
    baseCurrency,
    currency,
    baseCurrencyAmount,
    quoteCurrencyAmount,
    feeAmount,
    extraFeeAmount,
    networkFeeAmount,
    areFeesIncluded,
    usdRate,
    cryptoTransactionId,
    failureReason,
  } = data;
  if (
    !baseCurrency ||
    !currency ||
    baseCurrencyAmount === undefined ||
    quoteCurrencyAmount === undefined ||
    feeAmount === undefined ||
    extraFeeAmount === undefined ||
    networkFeeAmount === undefined ||
    areFeesIncluded === undefined ||
    usdRate === undefined
  ) {
    return undefined;
  }
  return {
    provider: "moonpay",
    status,
    baseCurrencyCode: baseCurrency.code.toUpperCase(),
    baseCurrencyAmount,
    quoteCurrencyCode: currency.code.toUpperCase(),
    quoteCurrencyAmount,
    feeAmount,
    extraFeeAmount,
    networkFeeAmount,
    areFeesIncluded,
    usdRate,
    ...(cryptoTransactionId ? { cryptoTransactionId } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
}

export class MoonpayRampClient implements RampProvider {
  readonly id = "moonpay";

  validateCounterparty(
    _counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return readyCounterparty(this.id, options.direction);
  }

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProvider["_discoverRails"]>[0]) {
    const apiKey = requireEnv(env, "MOONPAY_SANDBOX_API_KEY");
    const base = "https://api.moonpay.com";

    await writeDump(
      RAMP_RAIL_DUMPS.moonpay.currencies.name,
      await fetchJson(
        this.id,
        "GET /v3/currencies?show=all",
        `${base}/v3/currencies?show=all&apiKey=${apiKey}`
      )
    );
    await writeDump(
      RAMP_RAIL_DUMPS.moonpay.countries.name,
      await fetchJson(this.id, "GET /v3/countries", `${base}/v3/countries`)
    );
  }

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(
      await readDump<readonly MoonpayCurrencyEntry[]>(RAMP_RAIL_DUMPS.moonpay.currencies.file)
    );
  }

  async validateWebhook({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<RampWebhookValidationResult> {
    const webhookKey = readMoonpayWebhookKey(env, environment);
    const signatureHeader = headers.get("moonpay-signature-v2")?.trim();
    if (!signatureHeader) {
      throw new AppError("UNAUTHORIZED", "MoonPay webhook is missing Moonpay-Signature-V2 header", {
        provider: this.id,
      });
    }

    const parsed = parseMoonpaySignatureV2Header(signatureHeader);
    if (!parsed) {
      throw new AppError("UNAUTHORIZED", "MoonPay webhook signature header is malformed", {
        provider: this.id,
      });
    }

    await verifyWebhookSignature({
      provider: this.id,
      signedPayload: `${parsed.timestamp}.${rawBody}`,
      signature: parsed.signature,
      algorithm: { type: "hmac-sha256", secret: webhookKey, encoding: "hex" },
      timestampSeconds: Number(parsed.timestamp),
    });

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw badRequest("MoonPay webhook body must be valid JSON", {
        provider: this.id,
      });
    }

    return { provider: this.id, payload };
  }

  parseSettlementEvent(payload: unknown): RampSettlementEvent {
    const { type, data } = payload as MoonpayTransactionWebhook;
    if (
      type !== "transaction_created" &&
      type !== "transaction_updated" &&
      type !== "transaction_failed"
    ) {
      return { provider: this.id, kind: "ignore", reason: `unsupported_event:${type}` };
    }

    const reference = data.externalTransactionId;
    if (!reference) {
      return { provider: this.id, kind: "ignore", reason: "missing_external_transaction_id" };
    }

    const kind = MOONPAY_TRANSACTION_STATUS[data.status];
    if (!kind) {
      return { provider: this.id, kind: "ignore", reason: `unsupported_status:${data.status}` };
    }
    if (kind === "failed") {
      const settlement = buildMoonpaySettlement(data, "failed");
      return {
        provider: this.id,
        kind,
        reference,
        ...(data.failureReason ? { error: data.failureReason } : {}),
        ...(settlement ? { settlement } : {}),
      };
    }
    if (kind === "settled") {
      const settlement = buildMoonpaySettlement(data, "completed");
      return {
        provider: this.id,
        kind,
        reference,
        ...(data.quoteCurrencyAmount !== undefined
          ? { receivedAmount: String(data.quoteCurrencyAmount) }
          : {}),
        ...(settlement ? { settlement } : {}),
      };
    }
    return { provider: this.id, kind, reference };
  }

  async estimateOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const config = readMoonpayConfig(env, mode);
    const currencyCode = normalizeMoonpayCurrencyCode(getCryptoRailAssetLabel(input.assetRail));
    const url = new URL(`${MOONPAY_API_BASE_URL}/v3/currencies/${currencyCode}/buy_quote`);
    url.searchParams.set("apiKey", config.apiKey);
    url.searchParams.set("baseCurrencyCode", input.fiatCurrency.toLowerCase());
    url.searchParams.set("baseCurrencyAmount", input.fiatAmount);
    const quote = await providerFetchJson<MoonpayBuyQuoteResponse>(this.id, url.toString(), {
      method: "GET",
    });
    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: String(quote.baseCurrencyAmount),
      cryptoAmount: String(quote.quoteCurrencyAmount),
      exchangeRate: String(quote.quoteCurrencyPrice),
      fees: {
        currency: input.fiatCurrency,
        total: String(quote.feeAmount + quote.networkFeeAmount + quote.extraFeeAmount),
        network: String(quote.networkFeeAmount),
        provider: String(quote.feeAmount),
      },
    };
  }

  async estimateOfframp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    const config = readMoonpayConfig(env, mode);
    const currencyCode = normalizeMoonpayCurrencyCode(getCryptoRailAssetLabel(input.assetRail));
    const url = new URL(`${MOONPAY_API_BASE_URL}/v3/currencies/${currencyCode}/sell_quote`);
    url.searchParams.set("apiKey", config.apiKey);
    url.searchParams.set("quoteCurrencyCode", input.fiatCurrency.toLowerCase());
    url.searchParams.set("baseCurrencyAmount", input.cryptoAmount);
    const quote = await providerFetchJson<MoonpaySellQuoteResponse>(this.id, url.toString(), {
      method: "GET",
    });
    return {
      provider: this.id,
      direction: "offramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: String(quote.quoteCurrencyAmount),
      cryptoAmount: String(quote.baseCurrencyAmount),
      exchangeRate: String(quote.baseCurrencyPrice),
      fees: {
        currency: input.fiatCurrency,
        total: String(quote.feeAmount + quote.extraFeeAmount),
        provider: String(quote.feeAmount),
      },
    };
  }

  async createOnrampQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    const amount = Number.parseFloat(input.fiatAmount);
    if (!Number.isFinite(amount) || amount < MOONPAY_ONRAMP_MIN_USD) {
      throw new AppError(
        "BAD_REQUEST",
        `MoonPay on-ramp requires fiatAmount to be at least ${MOONPAY_ONRAMP_MIN_USD} USD`
      );
    }

    const config = readMoonpayConfig(env, mode);
    const quoteId = rampId("ramp_quote");
    const hostedUrl = await buildSignedMoonpayWidgetUrl(config.onrampUrl, config.secretKey, {
      apiKey: config.apiKey,
      baseCurrencyCode: (input.fiatCurrency ?? "USD").toLowerCase(),
      baseCurrencyAmount: input.fiatAmount,
      currencyCode: normalizeMoonpayCurrencyCode(input.cryptoToken),
      walletAddress: input.destinationWalletAddress,
      redirectURL: input.redirectUrl,
      externalCustomerId: input.externalCustomerId,
      externalTransactionId: quoteId,
    });

    return {
      provider: "moonpay",
      id: quoteId,
      status: "pending",
      deliveryMode: "hosted",
      hostedUrl,
    };
  }

  async createOfframpQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    const config = readMoonpayConfig(env, mode);
    const quoteId = rampId("ramp_quote");
    const hostedUrl = await buildSignedMoonpayWidgetUrl(config.offrampUrl, config.secretKey, {
      apiKey: config.apiKey,
      baseCurrencyCode: normalizeMoonpayCurrencyCode(input.cryptoToken),
      baseCurrencyAmount: input.cryptoAmount,
      quoteCurrencyCode: (input.fiatCurrency ?? "USD").toLowerCase(),
      refundWalletAddress: input.sourceWalletAddress,
      redirectURL: input.redirectUrl,
      externalCustomerId: input.externalCustomerId,
      externalTransactionId: quoteId,
    });

    return {
      provider: "moonpay",
      id: quoteId,
      status: "pending",
      deliveryMode: "hosted",
      hostedUrl,
    };
  }
}
