import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Counterparty } from "@sdp/types/counterparties";
import { RAMP_PROVIDER_SUPPORT_DETAILS, type RampFiatCurrency } from "@sdp/types/generated/ramp";
import {
  type CryptoRailId,
  getCryptoRailAssetLabel,
  type RampCurrencyLimit,
} from "@sdp/types/payment-rails";
import type { PaymentRampEstimate, PaymentRampQuote, RampTransferType } from "@sdp/types/payments";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { isSolanaError, SOLANA_ERROR__FIXED_POINTS__VALUE_OUT_OF_RANGE } from "@solana/kit";
import { z } from "zod";
import { compareDecimalAmounts, decimalStringFromNumber, sumDecimalAmounts } from "#/decimal";
import { providerNotConfigured, rampAmountOutOfRange, SdpPaymentsError } from "#/errors";
import {
  classifyProviderFailure,
  providerFetch,
  providerFetchJson,
  readProviderJson,
} from "#/ramps/fetch";
import { readyCounterparty } from "#/ramps/requirements";
import {
  isActiveIso4217CurrencyCode,
  isIso3166Alpha2CountryCode,
  RAMP_RAIL_DUMPS,
  rampCredentials,
  unreportedCurrencyLimit,
} from "#/ramps/shared";
import type {
  ProviderDeclaredRailSupport,
  ProviderRailSupportDistillation,
  RampDiscoveryContext,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampKeyFormats,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampProviderCancelOutcome,
  RampRuntimeContext,
  RampTransferLookup,
  ValidateCounterpartyOptions,
} from "#/ramps/types";
import {
  isMoonpayCryptoCode,
  MOONPAY_CRYPTO_CODE_TO_RAIL,
  MOONPAY_CRYPTO_CODES,
  type MoonpayCryptoCode,
  type MoonpaySettlementEvent,
  moonpayBuyTransactionSchema,
  moonpaySellTransactionSchema,
  moonpaySellTransactionSettlementEvent,
  moonpayTransactionSettlementEvent,
  withMoonpaySettledAsset,
} from "./event-status-mapping";

const MOONPAY_API_BASE_URL = "https://api.moonpay.com";

/** The widget hosts each mode's keys open. */
const MOONPAY_WIDGET_URLS = {
  sandbox: {
    onramp: "https://buy-sandbox.moonpay.com",
    offramp: "https://sell-sandbox.moonpay.com",
  },
  production: { onramp: "https://buy.moonpay.com", offramp: "https://sell.moonpay.com" },
} as const satisfies Record<SdpEnvironment, Record<RampTransferType, string>>;

/** MoonPay's webhook key is one per account and mode. */
const MOONPAY_KEY_FORMATS = {
  sandbox: { publicKey: /^pk_test_/, secretKey: /^sk_test_/, webhookSecret: /^wk_test_/ },
  production: { publicKey: /^pk_live_/, secretKey: /^sk_live_/, webhookSecret: /^wk_live_/ },
} as const satisfies RampKeyFormats;

/**
 * The buy widget opens on card and spends the amount it is given, fees
 * included; buy quotes ask on the same terms so an estimate matches the charge.
 */
const MOONPAY_ONRAMP_PAYMENT_METHOD = "credit_debit_card";

export const MOONPAY_DECLARED_RAIL_SUPPORT = {
  onramp: { entityTypes: ["individual"] },
  offramp: { entityTypes: ["individual"] },
} as const satisfies ProviderDeclaredRailSupport;

/** The fields `estimateOnramp` reads from a MoonPay buy quote. */
const moonpayBuyQuoteSchema = z.object({
  baseCurrencyAmount: z.number(),
  quoteCurrencyAmount: z.number(),
  quoteCurrencyPrice: z.number(),
  feeAmount: z.number(),
  networkFeeAmount: z.number(),
  extraFeeAmount: z.number(),
  totalAmount: z.number().optional(),
});

/** The fields `estimateOfframp` reads from a MoonPay sell quote. */
const moonpaySellQuoteSchema = z.object({
  baseCurrencyAmount: z.number(),
  quoteCurrencyAmount: z.number(),
  baseCurrencyPrice: z.number(),
  feeAmount: z.number(),
  extraFeeAmount: z.number(),
  // MoonPay quotes a sale over its maximum, so SDP reads the bound itself.
  baseCurrency: z.object({ maxSellAmount: z.number().nullish() }).optional(),
});

/** The minimum, in the crypto sold, that MoonPay names when it refuses a sale under it. */
const moonpaySellMinimumSchema = z
  .object({ errors: z.array(z.object({ property: z.string(), message: z.string() })) })
  .transform(
    (body) => body.errors.find((entry) => entry.property === "minSellCryptoAmount")?.message
  )
  .pipe(z.string().regex(/^\d+(\.\d+)?$/));

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

function compareMoonpayAmount(
  field: "fiatAmount" | "cryptoAmount",
  amount: string,
  bound: string
): number {
  try {
    return compareDecimalAmounts(amount, bound);
  } catch (error) {
    if (isSolanaError(error, SOLANA_ERROR__FIXED_POINTS__VALUE_OUT_OF_RANGE)) {
      throw new SdpPaymentsError("BAD_REQUEST", `${field} is out of range`);
    }
    throw error;
  }
}

function assertMoonpayOnrampAmount(fiatCurrency: RampFiatCurrency, fiatAmount: string): void {
  const limit = MOONPAY_ONRAMP_LIMITS.get(fiatCurrency);
  if (limit === undefined) {
    throw new SdpPaymentsError("BAD_REQUEST", `MoonPay on-ramp does not support ${fiatCurrency}`);
  }
  if (limit.min !== null && compareMoonpayAmount("fiatAmount", fiatAmount, limit.min) < 0) {
    throw new SdpPaymentsError(
      "BAD_REQUEST",
      `MoonPay on-ramp requires fiatAmount to be at least ${limit.min} ${fiatCurrency}`
    );
  }
  if (limit.max !== null && compareMoonpayAmount("fiatAmount", fiatAmount, limit.max) > 0) {
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

/** Where MoonPay looks transactions up by the external id SDP signs into the widget. */
const MOONPAY_TRANSFER_LOOKUP_PATHS = {
  onramp: "/v1/transactions/ext",
  offramp: "/v3/sell_transactions/ext",
} as const satisfies Record<RampTransferType, string>;

/** Every buy MoonPay holds for one external id. */
const moonpayBuyLookupSchema = z.array(moonpayBuyTransactionSchema);

/** Every sale MoonPay holds for one external id, with the crypto each one sells. */
const moonpaySellLookupSchema = z.array(
  moonpaySellTransactionSchema.extend({
    baseCurrency: z.object({ code: z.string() }).optional(),
  })
);

/** The fields every looked-up transaction carries, for correlation and order. */
interface MoonpayLookupTransaction {
  externalTransactionId?: string | null;
  updatedAt: string;
}

/**
 * Reads every transaction MoonPay holds for one transfer, oldest update
 * first. MoonPay answers an external id it holds nothing for with 404, which
 * reads as none; every other failure throws.
 *
 * @param url - The external-id lookup URL, carrying the publishable key.
 * @param transferId - The SDP transfer id the lookup asks about.
 * @param schema - The direction's transaction list schema.
 * @returns The transactions, oldest `updatedAt` first.
 * @throws SdpPaymentsError PROVIDER_RESPONSE_INVALID when a transaction names another transfer.
 */
async function lookUpMoonpayTransactions<TTransaction extends MoonpayLookupTransaction>(
  url: URL,
  transferId: string,
  schema: z.ZodType<TTransaction[]>
): Promise<TTransaction[]> {
  let transactions: TTransaction[];
  try {
    transactions = await providerFetchJson("moonpay", url.toString(), { method: "GET" }, schema);
  } catch (error) {
    if (error instanceof SdpPaymentsError && error.details?.providerStatus === 404) {
      return [];
    }
    throw error;
  }
  // The settlement guard locks the transfer an event names, so every event must name this one.
  if (transactions.some((transaction) => transaction.externalTransactionId !== transferId)) {
    throw new SdpPaymentsError(
      "PROVIDER_RESPONSE_INVALID",
      "moonpay returned a transaction for another transfer",
      { provider: "moonpay", outcome: "unknown" }
    );
  }
  return [...transactions].sort(
    (left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
  );
}

/**
 * A looked-up transaction with the crypto it moved. A completed one without it
 * cannot be redelivered like a webhook, so it is unreadable.
 *
 * @param event - The transaction's settlement event.
 * @param cryptoCode - The MoonPay code of the crypto the transaction moved.
 * @returns The event, with `deliveredAssetRail` when it is settled.
 * @throws SdpPaymentsError PROVIDER_RESPONSE_INVALID for a completed transaction without its crypto.
 */
function withSettledMoonpayAsset(
  event: MoonpaySettlementEvent,
  cryptoCode: string | undefined
): MoonpaySettlementEvent {
  const withAsset = withMoonpaySettledAsset(event, cryptoCode);
  if (withAsset === null) {
    throw new SdpPaymentsError(
      "PROVIDER_RESPONSE_INVALID",
      "moonpay returned a completed transaction without its crypto",
      { provider: "moonpay", outcome: "unknown" }
    );
  }
  return withAsset;
}

export class MoonpayRampClient implements RampProvider<MoonpaySettlementEvent> {
  readonly id = "moonpay";
  readonly label = "MoonPay";
  readonly declaredRailSupport = MOONPAY_DECLARED_RAIL_SUPPORT;
  readonly keyFormats = MOONPAY_KEY_FORMATS;

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
      const { credentials, fetchJson, writeDump } = context;
      if (!credentials.ok) {
        throw providerNotConfigured(credentials.reason);
      }
      await writeDump(
        RAMP_RAIL_DUMPS.moonpay.currencies.name,
        await fetchJson(
          this.id,
          "GET /v3/currencies?show=all",
          `${MOONPAY_API_BASE_URL}/v3/currencies?show=all&apiKey=${credentials.credentials.publicKey}`
        )
      );
      await writeDump(
        RAMP_RAIL_DUMPS.moonpay.countries.name,
        await fetchJson(this.id, "GET /v3/countries", `${MOONPAY_API_BASE_URL}/v3/countries`)
      );
    }
    const [currencies, countries] = await Promise.all([
      context.readDump(RAMP_RAIL_DUMPS.moonpay.currencies.file),
      context.readDump(RAMP_RAIL_DUMPS.moonpay.countries.file),
    ]);
    return distillMoonpayRailSupport(currencies, countries);
  }

  async estimateOnramp(
    ctx: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const { publicKey } = rampCredentials(this, ctx);
    const currencyCode = moonpayCryptoCode(input.assetRail);
    const url = new URL(`${MOONPAY_API_BASE_URL}/v3/currencies/${currencyCode}/buy_quote`);
    url.searchParams.set("apiKey", publicKey);
    url.searchParams.set("baseCurrencyCode", input.fiatCurrency.toLowerCase());
    url.searchParams.set("baseCurrencyAmount", input.fiatAmount);
    url.searchParams.set("areFeesIncluded", "true");
    url.searchParams.set("paymentMethod", MOONPAY_ONRAMP_PAYMENT_METHOD);
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
      // The fees come out of what the customer gave: the base is what buys the crypto.
      totalFiatAmount:
        quote.totalAmount === undefined
          ? sumDecimalAmounts([
              String(quote.baseCurrencyAmount),
              String(quote.feeAmount),
              String(quote.networkFeeAmount),
              String(quote.extraFeeAmount),
            ])
          : decimalStringFromNumber(quote.totalAmount),
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
    ctx: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    const { publicKey } = rampCredentials(this, ctx);
    const currencyCode = moonpayCryptoCode(input.assetRail);
    const url = new URL(`${MOONPAY_API_BASE_URL}/v3/currencies/${currencyCode}/sell_quote`);
    url.searchParams.set("apiKey", publicKey);
    url.searchParams.set("quoteCurrencyCode", input.fiatCurrency.toLowerCase());
    url.searchParams.set("baseCurrencyAmount", input.cryptoAmount);
    const answer = await providerFetch(this.id, url.toString(), { method: "GET" });
    const asset = getCryptoRailAssetLabel(input.assetRail);
    if (answer.response.status === 400) {
      const minimum = moonpaySellMinimumSchema.safeParse(answer.parsed);
      if (minimum.success) {
        throw rampAmountOutOfRange("amount_below_minimum", {
          amount: minimum.data,
          currency: asset,
        });
      }
    }
    const quote = readProviderJson(this.id, answer, moonpaySellQuoteSchema);
    const maximum = quote.baseCurrency?.maxSellAmount;
    if (
      maximum !== undefined &&
      maximum !== null &&
      compareMoonpayAmount("cryptoAmount", input.cryptoAmount, decimalStringFromNumber(maximum)) > 0
    ) {
      throw rampAmountOutOfRange("amount_above_maximum", {
        amount: decimalStringFromNumber(maximum),
        currency: asset,
      });
    }
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
    ctx: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    const fiatCurrency = input.fiatCurrency ?? "USD";
    assertMoonpayOnrampAmount(fiatCurrency, input.fiatAmount);

    const { publicKey, secretKey } = rampCredentials(this, ctx);
    const quoteId = requireMoonpayTransferId(input.paymentTransferId);
    const widgetUrl = MOONPAY_WIDGET_URLS[ctx.mode].onramp;
    const hostedUrl = await buildSignedMoonpayWidgetUrl(widgetUrl, secretKey, {
      apiKey: publicKey,
      baseCurrencyCode: fiatCurrency.toLowerCase(),
      baseCurrencyAmount: input.fiatAmount,
      currencyCode: moonpayCryptoCode(input.assetRail),
      walletAddress: input.destinationWalletAddress,
      lockAmount: "true",
      paymentMethod: MOONPAY_ONRAMP_PAYMENT_METHOD,
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
    ctx: RampRuntimeContext,
    input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    const { publicKey, secretKey } = rampCredentials(this, ctx);
    const quoteId = requireMoonpayTransferId(input.paymentTransferId);
    const widgetUrl = MOONPAY_WIDGET_URLS[ctx.mode].offramp;
    const hostedUrl = await buildSignedMoonpayWidgetUrl(widgetUrl, secretKey, {
      apiKey: publicKey,
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

  /** One request, authorized by the secret key: MoonPay's cancel of the sale held under SDP's id. */
  async cancelOfframpSale(
    ctx: RampRuntimeContext,
    transferId: string,
    signal?: AbortSignal
  ): Promise<RampProviderCancelOutcome> {
    const { secretKey } = rampCredentials(this, ctx);
    const url = `${MOONPAY_API_BASE_URL}${MOONPAY_TRANSFER_LOOKUP_PATHS.offramp}/${encodeURIComponent(transferId)}`;
    const { response } = await providerFetch(this.id, url, {
      method: "DELETE",
      headers: { Authorization: `Api-Key ${secretKey}` },
      signal,
    });
    if (response.ok) return "canceled";
    if (response.status === 404) return "not_found";
    if (response.status === 409) return "not_cancelable";
    const { code, outcome } = classifyProviderFailure(response.status);
    throw new SdpPaymentsError(code, `${this.id} request failed with status ${response.status}`, {
      provider: this.id,
      providerStatus: response.status,
      outcome,
    });
  }

  /**
   * One request: every transaction MoonPay holds under the transfer's id,
   * mapped as the webhook maps it. A retried checkout leaves one transaction
   * per attempt, and the settlement guard orders each only against itself.
   */
  async fetchTransferStatus(
    ctx: RampRuntimeContext,
    lookup: RampTransferLookup
  ): Promise<readonly MoonpaySettlementEvent[]> {
    const { publicKey } = rampCredentials(this, ctx);
    const path = MOONPAY_TRANSFER_LOOKUP_PATHS[lookup.rampType];
    const url = new URL(`${MOONPAY_API_BASE_URL}${path}/${encodeURIComponent(lookup.transferId)}`);
    url.searchParams.set("apiKey", publicKey);
    if (lookup.rampType === "onramp") {
      const buys = await lookUpMoonpayTransactions(url, lookup.transferId, moonpayBuyLookupSchema);
      return buys.map((buy) =>
        withSettledMoonpayAsset(moonpayTransactionSettlementEvent(buy), buy.currency?.code)
      );
    }
    const sales = await lookUpMoonpayTransactions(url, lookup.transferId, moonpaySellLookupSchema);
    return sales.map((sale) =>
      withSettledMoonpayAsset(moonpaySellTransactionSettlementEvent(sale), sale.baseCurrency?.code)
    );
  }
}
