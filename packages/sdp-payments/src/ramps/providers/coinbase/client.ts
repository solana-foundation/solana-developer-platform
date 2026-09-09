import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { Counterparty, PaymentRampEstimate, PaymentRampQuote } from "@sdp/types";
import { type CryptoRailId, getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { COINBASE_HOSTED_APPROVED_HOSTS, checkRampDestination } from "@sdp/types/ramp-destinations";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { divideDecimalAmounts, sumDecimalAmounts } from "../../../decimal";
import { badRequest, providerNotConfigured, providerUnavailable } from "../../../errors";
import { providerFetchJson } from "../../fetch";
import {
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  requireEnv,
  SOLANA_ASSET_TO_RAIL,
  UNREPORTED_COUNTRY_SUPPORT,
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
import { coinbaseCounterpartyRequirements } from "./counterparty";

// v1 API (Bearer JWT): buy options, buy quote — used for rail discovery + estimates.
const CDP_V1_API_BASE_URL = "https://api.developer.coinbase.com";
// v2 headless API: create order (returns an Apple/Google-Pay payment link).
const CDP_V2_ORDERS_URL = "https://api.cdp.coinbase.com/platform/v2/onramp/orders";

const SOLANA_NETWORK = "solana";
// Headless on-ramp settles through the guest-checkout Apple Pay button rendered in the iframe.
const ONRAMP_PAYMENT_METHOD = "GUEST_CHECKOUT_APPLE_PAY";
// Estimate through the same rail the order will use so the fee preview matches.
const ESTIMATE_PAYMENT_METHOD = "APPLE_PAY";

export const COINBASE_DECLARED_RAIL_SUPPORT = {
  onramp: {
    countrySupport: { coverage: "by-country", countries: { US: ["USD"] } },
    entityTypes: ["individual"],
  },
  offramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: [],
  },
} as const satisfies ProviderDeclaredRailSupport;

interface CoinbaseConfig {
  apiKeyName: string;
  apiKeySecret: string;
}

// Onramp REST auth uses the account-wide CDP Secret API Key (same key across products and
// environments — sandbox is flagged via the partnerUserRef prefix, not separate credentials).
function readCoinbaseConfig(env: Record<string, string | undefined>): CoinbaseConfig {
  const apiKeyName = env.COINBASE_CDP_API_KEY_ID?.trim();
  const apiKeySecret = env.COINBASE_CDP_API_KEY_SECRET?.trim();
  if (!apiKeyName || !apiKeySecret) {
    throw providerNotConfigured(
      "Coinbase Onramp is not configured. Set COINBASE_CDP_API_KEY_ID and COINBASE_CDP_API_KEY_SECRET."
    );
  }
  return { apiKeyName, apiKeySecret };
}

const buyOptionsSchema = z.object({
  purchase_currencies: z.array(
    z.object({
      symbol: z.string(),
      networks: z.array(z.object({ name: z.string() })),
    })
  ),
  payment_currencies: z.array(
    z.object({
      id: z.string(),
      limits: z.array(z.object({ id: z.string(), min: z.string(), max: z.string() })),
    })
  ),
});

type BuyOptionsDump = z.infer<typeof buyOptionsSchema>;

/**
 * USD bounds for the payment method the headless integration actually quotes
 * with (APPLE_PAY) — limits for methods our flow cannot use would overstate
 * what a user can transact (FIAT_WALLET alone reaches $1M).
 */
function coinbaseUsdLimit(dump: BuyOptionsDump) {
  const usd = dump.payment_currencies.find((entry) => entry.id.toUpperCase() === "USD");
  if (usd === undefined) {
    throw providerUnavailable("Coinbase buy options did not include USD payment limits.");
  }
  const limit = usd.limits.find((entry) => entry.id === ESTIMATE_PAYMENT_METHOD);
  if (limit === undefined) {
    throw providerUnavailable(
      `Coinbase buy options did not include USD ${ESTIMATE_PAYMENT_METHOD} limits.`
    );
  }
  return { min: limit.min, max: limit.max };
}

export function distillCoinbaseRailSupport(raw: unknown): ProviderRailSupportDistillation {
  const dump = buyOptionsSchema.parse(raw);
  const cryptos = new Set<CryptoRailId>();
  for (const currency of dump.purchase_currencies) {
    if (!currency.networks.some((network) => network.name === SOLANA_NETWORK)) {
      continue;
    }
    const symbol = currency.symbol.toUpperCase();
    if (!isSolanaCryptoAsset(symbol)) {
      continue;
    }
    cryptos.add(SOLANA_ASSET_TO_RAIL[symbol]);
  }
  return {
    snapshot: {
      onramp: {
        currencies: { USD: coinbaseUsdLimit(dump) },
        cryptos: [...cryptos].sort(),
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

interface CoinbaseAmount {
  value: string;
}

interface CoinbaseBuyQuoteResponse {
  purchase_amount: CoinbaseAmount;
  payment_subtotal: CoinbaseAmount;
  payment_total: CoinbaseAmount;
  coinbase_fee: CoinbaseAmount;
  network_fee: CoinbaseAmount;
}

interface CoinbaseOrderFee {
  amount: string;
  currency: string;
  type: string;
}

interface CoinbaseCreateOrderResponse {
  order: {
    orderId: string;
    status: string;
    paymentCurrency: string;
    paymentSubtotal: string;
    paymentTotal: string;
    purchaseCurrency: string;
    purchaseAmount: string;
    exchangeRate: string;
    fees: CoinbaseOrderFee[];
  };
  paymentLink: { url: string; paymentLinkType: string };
  // Embedded orders also return `userAuthToken`; it is intentionally not modelled so nothing
  // can read, log or persist it (see createOnrampQuote).
}

/**
 * Hosts Coinbase will never allow-list. Embedding the payment link on a local page is
 * permitted, but the `domain` field is refused for these names, so local runs omit it.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/** Embedded-mode create-order body: payment details and the partner reference, never contact data. */
type CoinbaseCreateOrderRequest = {
  paymentCurrency: string;
  purchaseCurrency: string;
  paymentMethod: string;
  destinationAddress: string;
  destinationNetwork: string;
  paymentAmount: string;
  partnerUserRef: string;
  domain?: string;
};

export class CoinbaseRampClient implements RampProvider {
  readonly id = "coinbase";
  readonly declaredRailSupport = COINBASE_DECLARED_RAIL_SUPPORT;

  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return coinbaseCounterpartyRequirements(counterparty, options);
  }

  async discoverCurrencyAndRails(
    context: RampDiscoveryContext
  ): Promise<ProviderRailSupportDistillation> {
    if (!context.offline) {
      const { env, fetchJson, writeDump } = context;
      const apiKeyName = requireEnv(env, "COINBASE_CDP_API_KEY_ID");
      const apiKeySecret = requireEnv(env, "COINBASE_CDP_API_KEY_SECRET");

      const jwt = await generateJwt({
        apiKeyId: apiKeyName,
        apiKeySecret,
        requestMethod: "GET",
        requestHost: new URL(CDP_V1_API_BASE_URL).host,
        requestPath: "/onramp/v1/buy/options",
      });

      await writeDump(
        RAMP_RAIL_DUMPS.coinbase.buyOptions.name,
        await fetchJson(
          this.id,
          "GET /onramp/v1/buy/options",
          `${CDP_V1_API_BASE_URL}/onramp/v1/buy/options?country=US&networks=solana`,
          { headers: { Authorization: `Bearer ${jwt}` } }
        )
      );
    }
    return distillCoinbaseRailSupport(
      await context.readDump(RAMP_RAIL_DUMPS.coinbase.buyOptions.file)
    );
  }

  async estimateOnramp(
    { env }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const quote = await this.request<CoinbaseBuyQuoteResponse>(
      env,
      "POST",
      `${CDP_V1_API_BASE_URL}/onramp/v1/buy/quote`,
      {
        purchase_currency: getCryptoRailAssetLabel(input.assetRail),
        purchase_network: SOLANA_NETWORK,
        payment_amount: input.fiatAmount,
        payment_currency: input.fiatCurrency,
        payment_method: ESTIMATE_PAYMENT_METHOD,
        country: "US",
      }
    );

    const crypto = Number(quote.purchase_amount.value);
    const subtotal = Number(quote.payment_subtotal.value);
    if (!Number.isFinite(crypto) || crypto === 0 || !Number.isFinite(subtotal)) {
      throw providerUnavailable("Coinbase returned an unusable buy quote.", {
        provider: this.id,
        purchaseAmount: quote.purchase_amount.value,
        paymentSubtotal: quote.payment_subtotal.value,
      });
    }
    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: quote.payment_total.value,
      cryptoAmount: quote.purchase_amount.value,
      exchangeRate: divideDecimalAmounts(quote.payment_subtotal.value, quote.purchase_amount.value),
      fees: {
        currency: input.fiatCurrency,
        total: sumDecimalAmounts([quote.coinbase_fee.value, quote.network_fee.value]),
        network: quote.network_fee.value,
        provider: quote.coinbase_fee.value,
      },
    };
  }

  async estimateOfframp(
    _ctx: RampRuntimeContext,
    _input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    throw badRequest("Coinbase Onramp does not support off-ramp.", { provider: this.id });
  }

  /**
   * Creates an embedded on-ramp order and returns its hosted payment link.
   *
   * Embedded mode: the request carries no buyer contact data. Coinbase collects the
   * buyer's phone number, email, one-time passwords and any identity information for a
   * limits upgrade inside the hosted flow, so no PII passes through SDP. The buyer is
   * identified to Coinbase only by `partnerUserRef`, derived from the counterparty id.
   *
   * Sandbox-only for now. Sandbox orders are flagged by a `sandbox-` prefix on
   * `partnerUserRef` (not separate credentials): the order always succeeds and the card is
   * never charged. The payment link gets `useApplePaySandbox=true`, which is required for
   * local-dev embedding and swaps the real Apple Pay sheet with a fake popup. Production
   * needs the embedding domain registered in the CDP portal and a real Apple Pay run, so
   * production mode fails loudly until that is done.
   *
   * `domain` is forwarded when the caller supplies a real host: Coinbase requires it to be a
   * CDP-portal-registered host and rejects `localhost` in any form with "Domain is not
   * allow listed", so local hostnames are dropped and registered previews and prod pass theirs.
   *
   * Coinbase also returns a reusable `userAuthToken` on embedded orders. It is deliberately
   * ignored here: never logged, never returned, never stored (decision 2026-09-08), so a
   * returning buyer re-verifies each order.
   *
   * @see https://docs.cdp.coinbase.com/onramp/headless-onramp/overview
   */
  async createOnrampQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    if (mode !== "sandbox") {
      throw providerUnavailable(
        "Coinbase Onramp production orders need the registered embedding domain and a real Apple Pay run, which are not done yet.",
        { provider: this.id }
      );
    }

    const partnerUserRef = `sandbox-${input.externalCustomerId}`;
    const orderRequest: CoinbaseCreateOrderRequest = {
      paymentCurrency: input.fiatCurrency ?? "USD",
      purchaseCurrency: getCryptoRailAssetLabel(input.assetRail),
      paymentMethod: ONRAMP_PAYMENT_METHOD,
      destinationAddress: input.destinationWalletAddress,
      destinationNetwork: SOLANA_NETWORK,
      paymentAmount: input.fiatAmount,
      partnerUserRef,
    };
    if (input.domain !== undefined && !isLocalHost(input.domain)) {
      orderRequest.domain = input.domain;
    }

    const { order, paymentLink } = await this.request<CoinbaseCreateOrderResponse>(
      env,
      "POST",
      CDP_V2_ORDERS_URL,
      orderRequest
    );

    // The dashboard iframes this URL and trusts its origin for postMessage
    // events, so anything but HTTPS on the approved payment-link host fails closed.
    const destination = checkRampDestination(paymentLink.url, [...COINBASE_HOSTED_APPROVED_HOSTS]);
    if (!destination.ok) {
      throw providerUnavailable("Coinbase returned an untrusted payment link URL.", {
        provider: this.id,
        reason: destination.reason,
      });
    }
    const hostedUrl = destination.url;
    hostedUrl.searchParams.set("useApplePaySandbox", "true");

    // The payment link URL is a signed, time-limited credential — never log it.
    console.log(
      `[coinbase onramp] order ${order.orderId} created (type: ${paymentLink.paymentLinkType})`
    );

    return {
      provider: this.id,
      id: order.orderId,
      status: "pending",
      deliveryMode: "hosted",
      hostedUrl: hostedUrl.href,
      paymentCurrency: order.paymentCurrency,
      paymentSubtotal: order.paymentSubtotal,
      paymentTotal: order.paymentTotal,
      purchaseCurrency: order.purchaseCurrency,
      purchaseAmount: order.purchaseAmount,
      exchangeRate: order.exchangeRate,
      fees: order.fees.map((fee) => ({
        feeAmount: fee.amount,
        feeCurrency: fee.currency,
        feeType: fee.type,
      })),
    };
  }

  async createOfframpQuote(
    _ctx: RampRuntimeContext,
    _input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    throw badRequest("Coinbase Onramp does not support off-ramp.", { provider: this.id });
  }

  private async request<TResponse>(
    env: Record<string, string | undefined>,
    method: "GET" | "POST",
    url: string,
    body?: Record<string, unknown>
  ): Promise<TResponse> {
    const { apiKeyName, apiKeySecret } = readCoinbaseConfig(env);
    const parsed = new URL(url);
    const jwt = await generateJwt({
      apiKeyId: apiKeyName,
      apiKeySecret,
      requestMethod: method,
      requestHost: parsed.host,
      requestPath: parsed.pathname,
    });

    return providerFetchJson<TResponse, Record<string, unknown>>(this.id, url, {
      method,
      ...(body === undefined ? {} : { body }),
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }
}
