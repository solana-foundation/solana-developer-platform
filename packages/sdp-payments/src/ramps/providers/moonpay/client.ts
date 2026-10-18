import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Counterparty } from "@sdp/types/counterparties";
import { RAMP_PROVIDER_SUPPORT_DETAILS, type RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CryptoRailId, RampCurrencyLimit } from "@sdp/types/payment-rails";
import type { PaymentRampEstimate, PaymentRampQuote } from "@sdp/types/payments";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { isSolanaError, SOLANA_ERROR__FIXED_POINTS__VALUE_OUT_OF_RANGE } from "@solana/kit";
import { z } from "zod";
import { compareDecimalAmounts, sumDecimalAmounts } from "../../../decimal";
import { providerNotConfigured, SdpPaymentsError } from "../../../errors";
import { providerFetchJson } from "../../fetch";
import { readyCounterparty } from "../../requirements";
import {
  isActiveIso4217CurrencyCode,
  isIso3166Alpha2CountryCode,
  RAMP_RAIL_DUMPS,
  requireEnv,
  unreportedCurrencyLimit,
} from "../../shared";
import type {
  ProviderDeclaredRailSupport,
  ProviderRailSupportDistillation,
  RampDiscoveryContext,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampRuntimeContext,
  ValidateCounterpartyOptions,
} from "../../types";

const MOONPAY_API_BASE_URL = "https://api.moonpay.com";
const MOONPAY_SANDBOX_ONRAMP_URL = "https://buy-sandbox.moonpay.com";
const MOONPAY_SANDBOX_OFFRAMP_URL = "https://sell-sandbox.moonpay.com";

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

/** The fields `estimateOnramp` reads from a MoonPay buy quote. */
const moonpayBuyQuoteSchema = z.object({
  baseCurrencyAmount: z.number(),
  quoteCurrencyAmount: z.number(),
  quoteCurrencyPrice: z.number(),
  feeAmount: z.number(),
  networkFeeAmount: z.number(),
  extraFeeAmount: z.number(),
});

/** The fields `estimateOfframp` reads from a MoonPay sell quote. */
const moonpaySellQuoteSchema = z.object({
  baseCurrencyAmount: z.number(),
  quoteCurrencyAmount: z.number(),
  baseCurrencyPrice: z.number(),
  feeAmount: z.number(),
  extraFeeAmount: z.number(),
});

/** The env keys SDP's managed MoonPay credentials and widget overrides live under. */
interface MoonpayManagedEnv {
  readonly MOONPAY_SANDBOX_API_KEY?: string;
  readonly MOONPAY_SANDBOX_SECRET_KEY?: string;
  readonly MOONPAY_ONRAMP_URL?: string;
  readonly MOONPAY_OFFRAMP_URL?: string;
}

const MOONPAY_TEST_API_KEY = /^pk_test_/;
const MOONPAY_TEST_SECRET_KEY = /^sk_test_/;

/**
 * The managed MoonPay keys for `mode`, or why SDP can't use them. SDP holds
 * sandbox keys only; a production project brings its own (HOO-1942), so
 * production fails closed until it can. Both keys must be test-mode keys, so
 * a live key mounted under the sandbox names can never reach MoonPay.
 */
function readMoonpayManagedKeys(
  env: MoonpayManagedEnv,
  mode: SdpEnvironment
): { ok: true; apiKey: string; secretKey: string } | { ok: false; reason: string } {
  if (mode === "production") {
    return { ok: false, reason: "MoonPay is not configured for production projects." };
  }
  const apiKey = env.MOONPAY_SANDBOX_API_KEY?.trim();
  const secretKey = env.MOONPAY_SANDBOX_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) {
    return {
      ok: false,
      reason:
        "MoonPay sandbox is not configured. Set MOONPAY_SANDBOX_API_KEY and MOONPAY_SANDBOX_SECRET_KEY.",
    };
  }
  if (!MOONPAY_TEST_API_KEY.test(apiKey) || !MOONPAY_TEST_SECRET_KEY.test(secretKey)) {
    return { ok: false, reason: "MoonPay sandbox keys must be test-mode keys." };
  }
  return { ok: true, apiKey, secretKey };
}

/**
 * Whether SDP's managed MoonPay keys can serve `mode`: the same check every
 * MoonPay call makes before its first request, so availability never disagrees.
 */
export function hasMoonpayManagedKeys(env: MoonpayManagedEnv, mode: SdpEnvironment): boolean {
  return readMoonpayManagedKeys(env, mode).ok;
}

function readMoonpayConfig(env: MoonpayManagedEnv, mode: SdpEnvironment): MoonpayConfig {
  const keys = readMoonpayManagedKeys(env, mode);
  if (!keys.ok) {
    throw providerNotConfigured(keys.reason);
  }

  const onrampUrl = env.MOONPAY_ONRAMP_URL ?? MOONPAY_SANDBOX_ONRAMP_URL;
  const offrampUrl = env.MOONPAY_OFFRAMP_URL ?? MOONPAY_SANDBOX_OFFRAMP_URL;

  try {
    new URL(onrampUrl);
    new URL(offrampUrl);
  } catch {
    throw new SdpPaymentsError("INTERNAL_ERROR", "MoonPay URL configuration is invalid.");
  }

  return { apiKey: keys.apiKey, secretKey: keys.secretKey, onrampUrl, offrampUrl };
}

function requireMoonpayTransferId(paymentTransferId: string | undefined): string {
  if (!paymentTransferId) {
    throw new SdpPaymentsError(
      "INTERNAL_ERROR",
      "MoonPay quote creation requires an SDP payment transfer id."
    );
  }
  return paymentTransferId;
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

/** The rail a MoonPay crypto code settles on, or null for an asset SDP has no rail for. */
export function moonpayCryptoRail(code: string): CryptoRailId | null {
  return isMoonpayCryptoCode(code) ? MOONPAY_CRYPTO_CODE_TO_RAIL[code] : null;
}

const MOONPAY_RAIL_TO_CODE: ReadonlyMap<CryptoRailId, MoonpayCryptoCode> = new Map(
  MOONPAY_CRYPTO_CODES.map((code): [CryptoRailId, MoonpayCryptoCode] => [
    MOONPAY_CRYPTO_CODE_TO_RAIL[code],
    code,
  ])
);

function moonpayCryptoCode(assetRail: CryptoRailId): MoonpayCryptoCode {
  const code = MOONPAY_RAIL_TO_CODE.get(assetRail);
  if (code === undefined) {
    throw new SdpPaymentsError("BAD_REQUEST", `MoonPay does not support ${assetRail}`);
  }
  return code;
}

const MOONPAY_ONRAMP_LIMITS: ReadonlyMap<string, RampCurrencyLimit> = new Map(
  Object.entries(RAMP_PROVIDER_SUPPORT_DETAILS.moonpay.onramp.currencies)
);

function compareMoonpayFiatAmount(fiatAmount: string, bound: string): number {
  try {
    return compareDecimalAmounts(fiatAmount, bound);
  } catch (error) {
    if (isSolanaError(error, SOLANA_ERROR__FIXED_POINTS__VALUE_OUT_OF_RANGE)) {
      throw new SdpPaymentsError("BAD_REQUEST", "fiatAmount is out of range");
    }
    throw error;
  }
}

function assertMoonpayOnrampAmount(fiatCurrency: RampFiatCurrency, fiatAmount: string): void {
  const limit = MOONPAY_ONRAMP_LIMITS.get(fiatCurrency);
  if (limit === undefined) {
    throw new SdpPaymentsError("BAD_REQUEST", `MoonPay on-ramp does not support ${fiatCurrency}`);
  }
  if (limit.min !== null && compareMoonpayFiatAmount(fiatAmount, limit.min) < 0) {
    throw new SdpPaymentsError(
      "BAD_REQUEST",
      `MoonPay on-ramp requires fiatAmount to be at least ${limit.min} ${fiatCurrency}`
    );
  }
  if (limit.max !== null && compareMoonpayFiatAmount(fiatAmount, limit.max) > 0) {
    throw new SdpPaymentsError(
      "BAD_REQUEST",
      `MoonPay on-ramp requires fiatAmount to be at most ${limit.max} ${fiatCurrency}`
    );
  }
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

  async discoverCurrencyAndRails(
    context: RampDiscoveryContext
  ): Promise<ProviderRailSupportDistillation> {
    if (!context.offline) {
      const { env, fetchJson, writeDump } = context;
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
    const [currencies, countries] = await Promise.all([
      context.readDump(RAMP_RAIL_DUMPS.moonpay.currencies.file),
      context.readDump(RAMP_RAIL_DUMPS.moonpay.countries.file),
    ]);
    return distillMoonpayRailSupport(currencies, countries);
  }

  async estimateOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const config = readMoonpayConfig(env, mode);
    const currencyCode = moonpayCryptoCode(input.assetRail);
    const url = new URL(`${MOONPAY_API_BASE_URL}/v3/currencies/${currencyCode}/buy_quote`);
    url.searchParams.set("apiKey", config.apiKey);
    url.searchParams.set("baseCurrencyCode", input.fiatCurrency.toLowerCase());
    url.searchParams.set("baseCurrencyAmount", input.fiatAmount);
    const quote = await providerFetchJson(
      this.id,
      url.toString(),
      { method: "GET" },
      moonpayBuyQuoteSchema
    );
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
        total: sumDecimalAmounts([
          String(quote.feeAmount),
          String(quote.networkFeeAmount),
          String(quote.extraFeeAmount),
        ]),
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
    const currencyCode = moonpayCryptoCode(input.assetRail);
    const url = new URL(`${MOONPAY_API_BASE_URL}/v3/currencies/${currencyCode}/sell_quote`);
    url.searchParams.set("apiKey", config.apiKey);
    url.searchParams.set("quoteCurrencyCode", input.fiatCurrency.toLowerCase());
    url.searchParams.set("baseCurrencyAmount", input.cryptoAmount);
    const quote = await providerFetchJson(
      this.id,
      url.toString(),
      { method: "GET" },
      moonpaySellQuoteSchema
    );
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
        total: sumDecimalAmounts([String(quote.feeAmount), String(quote.extraFeeAmount)]),
        provider: String(quote.feeAmount),
      },
    };
  }

  async createOnrampQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    const fiatCurrency = input.fiatCurrency ?? "USD";
    assertMoonpayOnrampAmount(fiatCurrency, input.fiatAmount);

    const config = readMoonpayConfig(env, mode);
    const quoteId = requireMoonpayTransferId(input.paymentTransferId);
    const hostedUrl = await buildSignedMoonpayWidgetUrl(config.onrampUrl, config.secretKey, {
      apiKey: config.apiKey,
      baseCurrencyCode: fiatCurrency.toLowerCase(),
      baseCurrencyAmount: input.fiatAmount,
      currencyCode: moonpayCryptoCode(input.assetRail),
      walletAddress: input.destinationWalletAddress,
      lockAmount: "true",
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
    const quoteId = requireMoonpayTransferId(input.paymentTransferId);
    const hostedUrl = await buildSignedMoonpayWidgetUrl(config.offrampUrl, config.secretKey, {
      apiKey: config.apiKey,
      baseCurrencyCode: moonpayCryptoCode(input.assetRail),
      baseCurrencyAmount: input.cryptoAmount,
      quoteCurrencyCode: (input.fiatCurrency ?? "USD").toLowerCase(),
      refundWalletAddress: input.sourceWalletAddress,
      lockAmount: "true",
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
