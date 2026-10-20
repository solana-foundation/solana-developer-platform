import { isDecimalString } from "@sdp/solana/amount";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Counterparty } from "@sdp/types/counterparties";
import type { PaymentRampEstimate, PaymentRampQuote } from "@sdp/types/payments";
import { checkRampDestination } from "@sdp/types/ramp-destinations";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { addDecimalAmounts, divideDecimalAmounts } from "#/decimal";
import {
  badRequest,
  estimateNotAvailable,
  internalError,
  providerNotConfigured,
  providerUnavailable,
  SdpPaymentsError,
} from "#/errors";
import { providerFetchJson } from "#/ramps/fetch";
import { readyCounterparty } from "#/ramps/requirements";
import {
  basicAuthHeader,
  UNREPORTED_COUNTRY_SUPPORT,
  unreportedCurrencyLimit,
} from "#/ramps/shared";
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
  RampSettlementEvent,
  RampTransferLookup,
  ValidateCounterpartyOptions,
} from "#/ramps/types";
import {
  stripeOnrampSessionStatusSchema,
  stripeSessionSettlementEvent,
} from "./session-status-mapping";

const STRIPE_API_BASE_URL = "https://api.stripe.com";
const STRIPE_API_VERSION = "2026-05-27.dahlia";
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

/** A string that is not blank: Stripe's session id and client secret. */
const stripeSessionFieldSchema = z.string().regex(/\S/);

/**
 * The fields `createOnrampQuote` reads from a Stripe onramp session, including
 * the locks Stripe echoes back so the quote can refuse a session without them.
 * The fiat amount and currency are only defaults the buyer can change in the
 * widget, so they are not read; settlement compares the observed amounts.
 */
const stripeOnrampSessionSchema = z.object({
  id: stripeSessionFieldSchema,
  client_secret: stripeSessionFieldSchema,
  redirect_url: z.string().nullable().optional(),
  transaction_details: z.object({
    destination_currencies: z.array(z.string()).nullable(),
    destination_networks: z.array(z.string()).nullable(),
    lock_wallet_address: z.boolean().nullable(),
    wallet_addresses: z.object({ solana: z.string().nullable().optional() }).nullable(),
  }),
});

type StripeOnrampSessionTerms = z.output<typeof stripeOnrampSessionSchema>["transaction_details"];

interface StripeQuotedTerms {
  currency: string;
  network: string;
  walletAddress: string;
}

/** Names the session locks that differ from the quote; empty when the session matches. */
function mismatchedStripeSessionTerms(
  terms: StripeOnrampSessionTerms,
  quoted: StripeQuotedTerms
): string[] {
  const mismatched: string[] = [];
  const isOnly = (values: string[] | null, expected: string) =>
    values !== null && values.length === 1 && values[0] === expected;
  if (!isOnly(terms.destination_currencies, quoted.currency)) {
    mismatched.push("destination_currencies");
  }
  if (!isOnly(terms.destination_networks, quoted.network)) {
    mismatched.push("destination_networks");
  }
  if (terms.lock_wallet_address !== true) {
    mismatched.push("lock_wallet_address");
  }
  if (terms.wallet_addresses?.solana !== quoted.walletAddress) {
    mismatched.push("wallet_addresses.solana");
  }
  return mismatched;
}

/** The fields `estimateOnramp` reads from Stripe's onramp quotes. */
/**
 * The fields `estimateOnramp` reads from Stripe's quotes. The request names one
 * network and one currency, so every entry is one the adapter can pick.
 */
const stripeOnrampQuotesSchema = z.object({
  destination_network_quotes: z.record(
    z.string(),
    z.array(
      z.object({
        destination_currency: z.string(),
        destination_amount: z.string(),
        fees: z.object({ network_fee_monetary: z.string(), transaction_fee_monetary: z.string() }),
      })
    )
  ),
});

/** The env keys SDP's managed Stripe credentials live under. */
interface StripeManagedEnv {
  readonly STRIPE_SANDBOX_SECRET_KEY?: string;
  readonly STRIPE_SANDBOX_PUBLISHABLE_KEY?: string;
}

/** A test-mode Stripe secret key: standard (`sk_`) or restricted (`rk_`). */
const STRIPE_TEST_SECRET_KEY = /^(sk|rk)_test_/;
const STRIPE_TEST_PUBLISHABLE_KEY = /^pk_test_/;

/**
 * The managed Stripe keys for `mode`, or why SDP can't use them. SDP holds
 * sandbox keys only; a production project brings its own (HOO-1943), so
 * production fails closed until it can. Both keys must be test-mode keys, so
 * a live key mounted under the sandbox names can never reach Stripe.
 */
function readStripeManagedKeys(
  env: StripeManagedEnv,
  mode: SdpEnvironment
): { ok: true; config: StripeConfig } | { ok: false; reason: string } {
  if (mode === "production") {
    return { ok: false, reason: "Stripe is not configured for production projects." };
  }
  const secretKey = env.STRIPE_SANDBOX_SECRET_KEY?.trim();
  const publishableKey = env.STRIPE_SANDBOX_PUBLISHABLE_KEY?.trim();
  if (!secretKey || !publishableKey) {
    return {
      ok: false,
      reason:
        "Stripe sandbox is not configured. Set STRIPE_SANDBOX_SECRET_KEY and STRIPE_SANDBOX_PUBLISHABLE_KEY.",
    };
  }
  if (
    !STRIPE_TEST_SECRET_KEY.test(secretKey) ||
    !STRIPE_TEST_PUBLISHABLE_KEY.test(publishableKey)
  ) {
    return { ok: false, reason: "Stripe sandbox keys must be test-mode keys." };
  }
  return { ok: true, config: { secretKey, publishableKey } };
}

/**
 * Whether SDP's managed Stripe keys can serve `mode`: the same check every
 * Stripe call makes before its first request, so availability never disagrees.
 */
export function hasStripeManagedKeys(env: StripeManagedEnv, mode: SdpEnvironment): boolean {
  return readStripeManagedKeys(env, mode).ok;
}

function readStripeConfig(env: StripeManagedEnv, mode: SdpEnvironment): StripeConfig {
  const keys = readStripeManagedKeys(env, mode);
  if (!keys.ok) {
    throw providerNotConfigured(keys.reason);
  }
  return keys.config;
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

function sumStripeFees(left: string, right: string): string {
  if (!isDecimalString(left) || !isDecimalString(right)) {
    throw providerUnavailable("Stripe returned an invalid decimal amount", { provider: "stripe" });
  }
  return addDecimalAmounts(left, right);
}

function stripeHeaders(secretKey: string, contentType?: string): HeadersInit {
  return {
    Authorization: basicAuthHeader(secretKey, ""),
    Accept: "application/json",
    "Stripe-Version": STRIPE_API_VERSION,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

async function stripeRequest<TSchema extends z.ZodType>(
  secretKey: string,
  url: string,
  form: StripeForm,
  schema: TSchema
): Promise<z.output<TSchema>> {
  return providerFetchJson(
    "stripe",
    url,
    {
      method: "POST",
      headers: stripeHeaders(secretKey, "application/x-www-form-urlencoded"),
      body: encodeStripeForm(form),
    },
    schema
  );
}

async function stripeGet<TSchema extends z.ZodType>(
  secretKey: string,
  url: string,
  query: StripeForm,
  schema: TSchema
): Promise<z.output<TSchema>> {
  const params = encodeStripeForm(query);
  const queryString = params.toString();
  const requestUrl = queryString ? `${url}?${queryString}` : url;
  return providerFetchJson(
    "stripe",
    requestUrl,
    { method: "GET", headers: stripeHeaders(secretKey) },
    schema
  );
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

  async discoverCurrencyAndRails(
    _context: RampDiscoveryContext
  ): Promise<ProviderRailSupportDistillation> {
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
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const config = readStripeConfig(env, mode);
    const { currency, network } = normalizeStripeOnrampAsset(input.assetRail);

    const quotes = await stripeGet(
      config.secretKey,
      `${STRIPE_API_BASE_URL}/v1/crypto/onramp/quotes`,
      {
        source_amount: input.fiatAmount,
        source_currency: input.fiatCurrency.toLowerCase(),
        destination_currencies: [currency],
        destination_networks: [network],
      },
      stripeOnrampQuotesSchema
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
      exchangeRate: divideDecimalAmounts(input.fiatAmount, match.destination_amount),
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
    { env, mode }: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    const config = readStripeConfig(env, mode);
    const { currency, network } = normalizeStripeOnrampAsset(input.assetRail);
    if (!input.fiatCurrency) {
      throw badRequest("Stripe on-ramp requires a fiat currency.", { provider: this.id });
    }

    const session = await stripeRequest(
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
        // A single-value list locks the choice: the buyer cannot switch asset or network.
        destination_currencies: [currency],
        destination_networks: [network],
        metadata: { externalCustomerId: input.externalCustomerId },
        customer_information: buildCustomerInformation(input.stripeCustomerInfo),
      },
      stripeOnrampSessionSchema
    );

    const mismatched = mismatchedStripeSessionTerms(session.transaction_details, {
      currency,
      network,
      walletAddress: input.destinationWalletAddress,
    });
    if (mismatched.length > 0) {
      throw providerUnavailable(
        "Stripe returned a session that does not match the quote.",
        { provider: this.id },
        { mismatched }
      );
    }

    const id = session.id;
    // The redirect URL is Stripe-account-configured (we never set it), so its
    // host set cannot be pinned here; it still must be a plain HTTPS URL —
    // protocol-relative or active-content values fail the whole quote closed.
    if (session.redirect_url) {
      const destination = checkRampDestination(session.redirect_url, null);
      if (!destination.ok) {
        throw providerUnavailable("Stripe returned an untrusted onramp redirect URL.", {
          provider: this.id,
          reason: destination.reason,
        });
      }
    }
    return {
      provider: "stripe",
      id,
      status: "pending",
      deliveryMode: "session_widget",
      clientSecret: session.client_secret,
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

  /**
   * One request: the onramp session the transfer was quoted with, mapped as
   * its webhook is. The key picks the mode, so there is no `livemode` to check.
   */
  async fetchTransferStatus(
    { env, mode }: RampRuntimeContext,
    lookup: RampTransferLookup
  ): Promise<readonly RampSettlementEvent[]> {
    const config = readStripeConfig(env, mode);
    if (lookup.rampType !== "onramp") {
      throw badRequest("Stripe off-ramp is not supported.", { provider: this.id });
    }
    const sessionId = lookup.providerReference;
    if (sessionId === null) {
      throw internalError("A Stripe status lookup requires the session id.", {
        provider: this.id,
      });
    }
    const session = await stripeGet(
      config.secretKey,
      `${STRIPE_API_BASE_URL}/v1/crypto/onramp_sessions/${encodeURIComponent(sessionId)}`,
      {},
      stripeOnrampSessionStatusSchema
    );
    if (session.id !== sessionId) {
      throw new SdpPaymentsError("PROVIDER_RESPONSE_INVALID", "stripe returned another session", {
        provider: this.id,
        outcome: "unknown",
      });
    }
    return [stripeSessionSettlementEvent(session)];
  }
}
