import type { PaymentRampExecution, PaymentRampQuote, SdpEnvironment } from "@sdp/types";
import { type CryptoRailId, parseFiatCurrency } from "@sdp/types/payment-rails";
import { AppError, providerNotConfigured } from "@/lib/errors";
import { createProviderRampSupport, RAMP_RAIL_DUMPS, rampId, requireEnv } from "../shared";
import type {
  MutableProviderRampSupport,
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

export class MoonpayRampClient implements RampProvider {
  readonly id = "moonpay";

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

  async validateWebhook(
    _context: RampWebhookValidationContext
  ): Promise<RampWebhookValidationResult> {
    throw new AppError("PROVIDER_NOT_CONFIGURED", "MoonPay webhook validation is not implemented", {
      provider: this.id,
    });
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

  async executeOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampExecuteOnrampInput
  ): Promise<PaymentRampExecution> {
    const amount = Number.parseFloat(input.fiatAmount);
    if (!Number.isFinite(amount) || amount < MOONPAY_ONRAMP_MIN_USD) {
      throw new AppError(
        "BAD_REQUEST",
        `MoonPay on-ramp requires fiatAmount to be at least ${MOONPAY_ONRAMP_MIN_USD} USD`
      );
    }

    const config = readMoonpayConfig(env, mode);
    const redirectUrl = await buildSignedMoonpayWidgetUrl(config.onrampUrl, config.secretKey, {
      apiKey: config.apiKey,
      baseCurrencyCode: (input.fiatCurrency ?? "USD").toLowerCase(),
      baseCurrencyAmount: input.fiatAmount,
      currencyCode: normalizeMoonpayCurrencyCode(input.cryptoToken),
      walletAddress: input.destinationWalletAddress,
      redirectURL: input.redirectUrl,
      externalCustomerId: input.kycReference,
      externalTransactionId: rampId("sdp_onramp"),
    });

    return { id: rampId("ramp"), provider: "moonpay", status: "pending", redirectUrl };
  }

  async executeOfframp(
    { env, mode }: RampRuntimeContext,
    input: RampExecuteOfframpInput
  ): Promise<PaymentRampExecution> {
    const config = readMoonpayConfig(env, mode);
    const externalTransactionId = rampId("sdp_offramp");
    const redirectUrl = await buildSignedMoonpayWidgetUrl(config.offrampUrl, config.secretKey, {
      apiKey: config.apiKey,
      baseCurrencyCode: normalizeMoonpayCurrencyCode(input.cryptoToken),
      baseCurrencyAmount: input.cryptoAmount,
      quoteCurrencyCode: (input.fiatCurrency ?? "USD").toLowerCase(),
      refundWalletAddress: input.sourceWalletAddress,
      redirectURL: input.redirectUrl,
      externalCustomerId: input.kycReference,
      externalTransactionId,
    });

    return {
      id: rampId("ramp"),
      provider: "moonpay",
      status: "pending",
      redirectUrl,
      reference: externalTransactionId,
    };
  }
}
