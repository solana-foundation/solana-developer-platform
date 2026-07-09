import type {
  Counterparty,
  PaymentRampEstimate,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import {
  type CryptoRailId,
  getCryptoRailAssetLabel,
  type RampCurrencyLimit,
} from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { providerNotConfigured, SdpPaymentsError } from "../../../errors";
import { providerFetchJson } from "../../fetch";
import { readyCounterparty } from "../../requirements";
import {
  isActiveIso4217CurrencyCode,
  isIso3166Alpha2CountryCode,
  RAMP_RAIL_DUMPS,
  rampId,
  requireEnv,
  unreportedCurrencyLimit,
} from "../../shared";
import type {
  ProviderDeclaredRailSupport,
  ProviderRailSupportDistillation,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampRawDumpReader,
  RampRuntimeContext,
  ValidateCounterpartyOptions,
} from "../../types";

const MOONPAY_API_BASE_URL = "https://api.moonpay.com";
const MOONPAY_ONRAMP_URL = "https://buy.moonpay.com";
const MOONPAY_OFFRAMP_URL = "https://sell.moonpay.com";
const MOONPAY_SANDBOX_ONRAMP_URL = "https://buy-sandbox.moonpay.com";
const MOONPAY_SANDBOX_OFFRAMP_URL = "https://sell-sandbox.moonpay.com";
const MOONPAY_ONRAMP_MIN_USD = 20;

export const MOONPAY_DECLARED_RAIL_SUPPORT = {
  onramp: { entityTypes: ["individual"] },
  offramp: { entityTypes: ["individual"] },
} as const satisfies ProviderDeclaredRailSupport;

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
    throw new SdpPaymentsError("INTERNAL_ERROR", "MoonPay URL configuration is invalid.");
  }

  return { apiKey, secretKey, onrampUrl, offrampUrl };
}

function normalizeMoonpayCurrencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(normalized)) {
    throw new SdpPaymentsError(
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

const moonpayCurrencyEntrySchema = z.object({
  type: z.string().optional(),
  code: z.string().optional(),
  isSuspended: z.boolean().optional(),
  isSellSupported: z.boolean().optional(),
  supportsTestMode: z.boolean().optional(),
  minBuyAmount: z.number().nullable().optional(),
  maxBuyAmount: z.number().nullable().optional(),
  minSellAmount: z.number().nullable().optional(),
  metadata: z.object({ networkCode: z.string().optional() }).optional(),
});

const moonpayCountriesSchema = z.array(
  z.object({
    alpha2: z.string(),
    isBuyAllowed: z.boolean(),
    isSellAllowed: z.boolean(),
  })
);

type MoonpayCurrencyEntry = z.infer<typeof moonpayCurrencyEntrySchema>;

function addMoonpayFiatSupport(
  entry: MoonpayCurrencyEntry,
  onrampCurrencies: Record<string, RampCurrencyLimit>,
  offrampCurrencies: Record<string, RampCurrencyLimit>,
  droppedCodes: Set<string>
): void {
  if (entry.code === undefined) {
    return;
  }
  const code = entry.code.trim().toUpperCase();
  if (!isActiveIso4217CurrencyCode(code)) {
    droppedCodes.add(code);
    return;
  }
  if (entry.minBuyAmount !== undefined && entry.minBuyAmount !== null) {
    onrampCurrencies[code] = {
      min: String(entry.minBuyAmount),
      max:
        entry.maxBuyAmount === undefined || entry.maxBuyAmount === null
          ? null
          : String(entry.maxBuyAmount),
    };
  }
  if (entry.isSellSupported === true) {
    offrampCurrencies[code] = unreportedCurrencyLimit();
  }
}

function addMoonpayCryptoSupport(
  entry: MoonpayCurrencyEntry,
  onrampCryptos: Set<CryptoRailId>,
  offrampCryptos: Set<CryptoRailId>
): void {
  if (entry.code === undefined) {
    return;
  }
  if (entry.isSuspended === true) {
    return;
  }
  if (entry.supportsTestMode !== true) {
    return;
  }
  if (entry.metadata === undefined) {
    return;
  }
  if (entry.metadata.networkCode !== "solana") {
    return;
  }
  if (!isMoonpayCryptoCode(entry.code)) {
    return;
  }

  const rail = MOONPAY_CRYPTO_CODE_TO_RAIL[entry.code];
  if (entry.minBuyAmount !== undefined && entry.minBuyAmount !== null) {
    onrampCryptos.add(rail);
  }
  if (
    entry.isSellSupported === true &&
    entry.minSellAmount !== undefined &&
    entry.minSellAmount !== null
  ) {
    offrampCryptos.add(rail);
  }
}

function moonpayCountryLists(countries: unknown, droppedCodes: Set<string>) {
  const parsed = moonpayCountriesSchema.parse(countries);
  const onrampCountries = new Set<string>();
  const offrampCountries = new Set<string>();
  for (const country of parsed) {
    const code = country.alpha2.trim().toUpperCase();
    if (!isIso3166Alpha2CountryCode(code)) {
      droppedCodes.add(code);
      continue;
    }
    if (country.isBuyAllowed) {
      onrampCountries.add(code);
    }
    if (country.isSellAllowed) {
      offrampCountries.add(code);
    }
  }
  return {
    onramp: [...onrampCountries].sort(),
    offramp: [...offrampCountries].sort(),
  };
}

export function distillMoonpayRailSupport(
  currenciesRaw: unknown,
  countriesRaw: unknown
): ProviderRailSupportDistillation {
  const currencies = z.array(moonpayCurrencyEntrySchema).parse(currenciesRaw);
  const droppedCurrencyCodes = new Set<string>();
  const droppedCountryCodes = new Set<string>();
  const onrampCurrencies: Record<string, RampCurrencyLimit> = {};
  const offrampCurrencies: Record<string, RampCurrencyLimit> = {};
  const onrampCryptos = new Set<CryptoRailId>();
  const offrampCryptos = new Set<CryptoRailId>();

  for (const entry of currencies) {
    if (entry.type === "fiat") {
      addMoonpayFiatSupport(entry, onrampCurrencies, offrampCurrencies, droppedCurrencyCodes);
    }
    if (entry.type === "crypto") {
      addMoonpayCryptoSupport(entry, onrampCryptos, offrampCryptos);
    }
  }

  const countryLists = moonpayCountryLists(countriesRaw, droppedCountryCodes);
  return {
    snapshot: {
      onramp: {
        currencies: onrampCurrencies,
        cryptos: [...onrampCryptos].sort(),
        countrySupport: { coverage: "all-currencies", countries: countryLists.onramp },
      },
      offramp: {
        currencies: offrampCurrencies,
        cryptos: [...offrampCryptos].sort(),
        countrySupport: { coverage: "all-currencies", countries: countryLists.offramp },
      },
    },
    droppedCurrencyCodes: [...droppedCurrencyCodes].sort(),
    droppedCountryCodes: [...droppedCountryCodes].sort(),
  };
}

export class MoonpayRampClient implements RampProvider {
  readonly id = "moonpay";
  readonly declaredRailSupport = MOONPAY_DECLARED_RAIL_SUPPORT;

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

  async distillRailSupport(readDump: RampRawDumpReader): Promise<ProviderRailSupportDistillation> {
    const [currencies, countries] = await Promise.all([
      readDump(RAMP_RAIL_DUMPS.moonpay.currencies.file),
      readDump(RAMP_RAIL_DUMPS.moonpay.countries.file),
    ]);
    return distillMoonpayRailSupport(currencies, countries);
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
      throw new SdpPaymentsError(
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
