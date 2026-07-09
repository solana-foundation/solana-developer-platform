import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import type { Counterparty, PaymentRampEstimate, PaymentRampQuote } from "@sdp/types";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import {
  badRequest,
  estimateNotAvailable,
  providerNotConfigured,
  providerUnavailable,
} from "../../../errors";
import { providerFetchJson } from "../../fetch";
import { readyCounterparty } from "../../requirements";
import { basicAuthHeader, UNREPORTED_COUNTRY_SUPPORT, unreportedCurrencyLimit } from "../../shared";
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

const STRIPE_API_BASE_URL = "https://api.stripe.com";
const STRIPE_API_VERSION = "2026-05-27.dahlia";
const STRIPE_ONRAMP_DESTINATION_CURRENCIES = ["usdc", "sol"] as const;
const STRIPE_ONRAMP_NETWORK = "solana";

export const STRIPE_DECLARED_RAIL_SUPPORT = {
  onramp: {
    countrySupport: { coverage: "by-country", countries: { US: ["USD"] } },
    entityTypes: ["individual"],
  },
  offramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: [],
  },
} as const satisfies ProviderDeclaredRailSupport;

interface StripeConfig {
  secretKey: string;
  publishableKey: string;
}

export interface StripeCustomerInfo {
  email?: string;
  firstName?: string;
  lastName?: string;
  dob?: { year: number; month: number; day: number };
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
}

type StripeFormValue =
  | string
  | number
  | boolean
  | StripeForm
  | readonly StripeFormValue[]
  | undefined;

interface StripeForm {
  [key: string]: StripeFormValue;
}

interface StripeOnrampSessionResponse {
  id: string;
  client_secret: string;
  status: string;
  redirect_url: string | null;
  transaction_details?: { destination_amount?: string | null };
}

interface StripeOnrampQuoteEntry {
  id: string;
  destination_network: string;
  destination_currency: string;
  destination_amount: string;
  fees: { network_fee_monetary: string; transaction_fee_monetary: string };
  source_total_amount: string;
}

interface StripeOnrampQuotesResponse {
  id: string;
  source_amount: string;
  source_currency: string;
  rate_fetched_at: number;
  destination_network_quotes: Record<string, StripeOnrampQuoteEntry[] | undefined>;
}

function readStripeConfig(env: Record<string, string | undefined>): StripeConfig {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY?.trim();
  if (!secretKey || !publishableKey) {
    throw providerNotConfigured(
      "Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY."
    );
  }
  return { secretKey, publishableKey };
}

function normalizeStripeOnrampAsset(cryptoToken: string): { currency: string; network: string } {
  const normalized = cryptoToken.trim().toLowerCase().replace(/_/g, ".");
  const separator = normalized.indexOf(".");
  const asset = separator === -1 ? normalized : normalized.slice(0, separator);
  if (asset === "usdc") {
    return { currency: "usdc", network: STRIPE_ONRAMP_NETWORK };
  }
  if (asset === "sol") {
    return { currency: "sol", network: STRIPE_ONRAMP_NETWORK };
  }
  throw badRequest("Stripe on-ramp supports usdc.solana and sol.solana only.", {
    provider: "stripe",
  });
}

function appendStripeForm(params: URLSearchParams, key: string, value: StripeFormValue): void {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      appendStripeForm(params, `${key}[]`, item);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      appendStripeForm(params, `${key}[${childKey}]`, childValue);
    }
    return;
  }
  params.append(key, String(value));
}

function encodeStripeForm(form: StripeForm): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    appendStripeForm(params, key, value);
  }
  return params;
}

function buildCustomerInformation(info: StripeCustomerInfo | undefined): StripeForm | undefined {
  if (!info) {
    return undefined;
  }

  const out: StripeForm = {};
  if (info.email) {
    out.email = info.email;
  }
  if (info.firstName) {
    out.first_name = info.firstName;
  }
  if (info.lastName) {
    out.last_name = info.lastName;
  }
  if (info.dob) {
    out.dob = { year: info.dob.year, month: info.dob.month, day: info.dob.day };
  }
  if (info.address) {
    const address: StripeForm = {};
    if (info.address.line1) {
      address.line1 = info.address.line1;
    }
    if (info.address.line2) {
      address.line2 = info.address.line2;
    }
    if (info.address.city) {
      address.city = info.address.city;
    }
    if (info.address.state) {
      address.state = info.address.state;
    }
    if (info.address.postalCode) {
      address.postal_code = info.address.postalCode;
    }
    if (info.address.country) {
      address.country = info.address.country;
    }
    if (Object.keys(address).length > 0) {
      out.address = address;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function assertSessionField(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw providerUnavailable(`Stripe session response is missing ${field}.`, {
      provider: "stripe",
    });
  }
  return value;
}

function stripeDecimalPlaces(value: string): number {
  if (!isDecimalString(value)) {
    throw providerUnavailable("Stripe returned an invalid decimal amount", { provider: "stripe" });
  }
  const decimalIndex = value.indexOf(".");
  return decimalIndex === -1 ? 0 : value.length - decimalIndex - 1;
}

function sumStripeFees(left: string, right: string): string {
  const decimals = Math.max(stripeDecimalPlaces(left), stripeDecimalPlaces(right));
  return formatDecimalAmount(
    parseDecimalAmount(left, decimals) + parseDecimalAmount(right, decimals),
    decimals
  );
}

function stripeHeaders(secretKey: string, contentType?: string): HeadersInit {
  return {
    Authorization: basicAuthHeader(secretKey, ""),
    Accept: "application/json",
    "Stripe-Version": STRIPE_API_VERSION,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

async function stripeRequest<TResponse>(
  secretKey: string,
  url: string,
  form: StripeForm
): Promise<TResponse> {
  return providerFetchJson<TResponse, URLSearchParams>("stripe", url, {
    method: "POST",
    headers: stripeHeaders(secretKey, "application/x-www-form-urlencoded"),
    body: encodeStripeForm(form),
  });
}

async function stripeGet<TResponse>(
  secretKey: string,
  url: string,
  query: StripeForm
): Promise<TResponse> {
  const params = encodeStripeForm(query);
  const queryString = params.toString();
  const requestUrl = queryString ? `${url}?${queryString}` : url;
  return providerFetchJson<TResponse>("stripe", requestUrl, {
    method: "GET",
    headers: stripeHeaders(secretKey),
  });
}

export class StripeRampClient implements RampProvider {
  readonly id = "stripe";
  readonly declaredRailSupport = STRIPE_DECLARED_RAIL_SUPPORT;

  validateCounterparty(
    _counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    if (options.direction === "offramp") {
      return {
        provider: this.id,
        direction: options.direction,
        status: "unsupported",
        reason: "Stripe supports on-ramp only.",
      };
    }
    return readyCounterparty(this.id, options.direction);
  }

  async _discoverRails(_context: Parameters<RampProvider["_discoverRails"]>[0]): Promise<void> {}

  async distillRailSupport(_readDump: RampRawDumpReader): Promise<ProviderRailSupportDistillation> {
    return {
      snapshot: {
        onramp: {
          currencies: { USD: unreportedCurrencyLimit() },
          cryptos: ["sol.solana", "usdc.solana"],
        },
        offramp: {
          currencies: {},
          cryptos: [],
        },
      },
      droppedCurrencyCodes: [],
      droppedCountryCodes: [],
    };
  }

  async estimateOnramp(
    { env }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const config = readStripeConfig(env);
    const { currency, network } = normalizeStripeOnrampAsset(input.assetRail);

    const quotes = await stripeGet<StripeOnrampQuotesResponse>(
      config.secretKey,
      `${STRIPE_API_BASE_URL}/v1/crypto/onramp/quotes`,
      {
        source_amount: input.fiatAmount,
        source_currency: input.fiatCurrency.toLowerCase(),
        destination_currencies: [currency],
        destination_networks: [network],
      }
    );

    const networkQuotes = quotes.destination_network_quotes[network];
    if (!networkQuotes) {
      throw estimateNotAvailable(
        `Stripe did not return an on-ramp quote for ${currency} on ${network}.`,
        { provider: this.id }
      );
    }

    const match = networkQuotes.find((quote) => quote.destination_currency === currency);
    if (!match) {
      throw estimateNotAvailable(
        `Stripe did not return an on-ramp quote for ${currency} on ${network}.`,
        { provider: this.id }
      );
    }

    const cryptoAmount = Number(match.destination_amount);
    if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
      throw providerUnavailable("Stripe returned a non-positive converted amount", {
        provider: this.id,
      });
    }

    const totalFee = sumStripeFees(
      match.fees.network_fee_monetary,
      match.fees.transaction_fee_monetary
    );

    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: input.fiatAmount,
      cryptoAmount: match.destination_amount,
      exchangeRate: String(Number(input.fiatAmount) / cryptoAmount),
      fees: {
        currency: input.fiatCurrency,
        total: totalFee,
        network: match.fees.network_fee_monetary,
        networkCurrency: input.fiatCurrency,
        provider: match.fees.transaction_fee_monetary,
        providerCurrency: input.fiatCurrency,
      },
    };
  }

  async estimateOfframp(
    _ctx: RampRuntimeContext,
    _input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    throw estimateNotAvailable("Stripe supports on-ramp only.", { provider: this.id });
  }

  async createOnrampQuote(
    { env }: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    const config = readStripeConfig(env);
    const { currency, network } = normalizeStripeOnrampAsset(input.cryptoToken);
    if (!input.fiatCurrency) {
      throw badRequest("Stripe on-ramp requires a fiat currency.", { provider: this.id });
    }

    const session = await stripeRequest<StripeOnrampSessionResponse>(
      config.secretKey,
      `${STRIPE_API_BASE_URL}/v1/crypto/onramp_sessions`,
      {
        customer_ip_address: input.customerIpAddress,
        wallet_addresses: { [network]: input.destinationWalletAddress },
        lock_wallet_address: true,
        source_currency: input.fiatCurrency.toLowerCase(),
        source_amount: input.fiatAmount,
        destination_currency: currency,
        destination_network: network,
        destination_currencies: [...STRIPE_ONRAMP_DESTINATION_CURRENCIES],
        destination_networks: [STRIPE_ONRAMP_NETWORK],
        metadata: { externalCustomerId: input.externalCustomerId },
        customer_information: buildCustomerInformation(input.stripeCustomerInfo),
      }
    );

    const id = assertSessionField(session.id, "id");
    return {
      provider: "stripe",
      id,
      status: "pending",
      deliveryMode: "session_widget",
      clientSecret: assertSessionField(session.client_secret, "client_secret"),
      sessionId: id,
      publishableKey: config.publishableKey,
      ...(session.redirect_url ? { redirectUrl: session.redirect_url } : {}),
    };
  }

  async createOfframpQuote(
    _ctx: RampRuntimeContext,
    _input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    throw badRequest("Stripe off-ramp is not supported.", { provider: this.id });
  }
}
