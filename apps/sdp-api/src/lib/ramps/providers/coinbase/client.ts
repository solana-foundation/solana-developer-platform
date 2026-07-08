import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { Counterparty, PaymentRampEstimate, PaymentRampQuote } from "@sdp/types";
import { getCryptoRailAssetLabel, parseFiatCurrency } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { badRequest, providerNotConfigured, providerUnavailable } from "@/lib/errors";
import { providerFetchJson } from "../../fetch";
import { readyCounterparty } from "../../requirements";
import {
  createProviderRampSupport,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  requireEnv,
  SOLANA_ASSET_TO_RAIL,
} from "../../shared";
import type {
  ProviderRampSupport,
  RampDumpReader,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampRuntimeContext,
  ValidateCounterpartyOptions,
} from "../../types";

// v1 API (Bearer JWT): buy options, buy quote — used for rail discovery + estimates.
const CDP_V1_API_BASE_URL = "https://api.developer.coinbase.com";
// v2 headless API: create order (returns an Apple/Google-Pay payment link).
const CDP_V2_ORDERS_URL = "https://api.cdp.coinbase.com/platform/v2/onramp/orders";

const SOLANA_NETWORK = "solana";
// Headless on-ramp settles through the guest-checkout Apple Pay button rendered in the iframe.
const ONRAMP_PAYMENT_METHOD = "GUEST_CHECKOUT_APPLE_PAY";
// Estimate through the same rail the order will use so the fee preview matches.
const ESTIMATE_PAYMENT_METHOD = "APPLE_PAY";

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

interface BuyOptionsNetwork {
  name: string;
}

interface BuyOptionsPurchaseCurrency {
  symbol: string;
  networks: BuyOptionsNetwork[];
}

interface BuyOptionsDump {
  purchase_currencies: BuyOptionsPurchaseCurrency[];
}

function extractSupport(dump: BuyOptionsDump): ProviderRampSupport {
  const support = createProviderRampSupport();

  // Headless v2 only quotes USD — don't derive fiats from payment_currencies.
  const usd = parseFiatCurrency("USD");
  if (usd) support.onrampFiats.add(usd);

  for (const currency of dump.purchase_currencies) {
    if (!currency.networks.some((network) => network.name === SOLANA_NETWORK)) continue;
    const symbol = currency.symbol.toUpperCase();
    if (!isSolanaCryptoAsset(symbol)) continue;
    support.onrampCryptos.add(SOLANA_ASSET_TO_RAIL[symbol]);
  }

  return support;
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

interface CoinbaseCreateOrderResponse {
  order: { orderId: string; status: string };
  paymentLink: { url: string; paymentLinkType: string };
}

export class CoinbaseRampClient implements RampProvider {
  readonly id = "coinbase";

  validateCounterparty(
    _counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    if (options.direction !== "onramp") {
      return {
        provider: this.id,
        direction: options.direction,
        status: "unsupported",
        reason: "Coinbase Onramp supports on-ramp only.",
      };
    }
    return readyCounterparty(this.id, options.direction);
  }

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProvider["_discoverRails"]>[0]): Promise<void> {
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

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(await readDump<BuyOptionsDump>(RAMP_RAIL_DUMPS.coinbase.buyOptions.file));
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

    const crypto = Number.parseFloat(quote.purchase_amount.value);
    const subtotal = Number.parseFloat(quote.payment_subtotal.value);
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
      exchangeRate: String(subtotal / crypto),
      fees: {
        currency: input.fiatCurrency,
        total: String(
          Number.parseFloat(quote.coinbase_fee.value) + Number.parseFloat(quote.network_fee.value)
        ),
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
   * Creates a guest-checkout Apple Pay order and returns its hosted payment link.
   *
   * Sandbox-only for now. Coinbase requires `agreementAcceptedAt` / `phoneNumberVerifiedAt`
   * timestamps attesting that the buyer accepted their user agreement and passed phone OTP;
   * sandbox orders (never charged) accept a request-time stamp, but production must carry
   * the real timestamps from an OTP flow SDP has not built yet — so production mode fails
   * loudly instead of sending a false attestation.
   *
   * Sandbox orders are flagged by a `sandbox-` prefix on `partnerUserRef` (not separate
   * credentials): the order always succeeds and the card is never charged. The payment link
   * gets `useApplePaySandbox=true`, which is required for local-dev embedding and swaps the
   * real Apple Pay sheet with a fake popup.
   *
   * `domain` is omitted: it must be a CDP-portal-registered domain — Coinbase rejects
   * `localhost` in any form with "Domain is not allow listed" (verified empirically); the
   * docs' localhost exemption applies to embedding the link, not to this field. The
   * production flow will need it passed once domain registration exists.
   *
   * @see https://docs.cdp.coinbase.com/onramp/headless-onramp/overview#web-app-testing
   */
  async createOnrampQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    if (mode !== "sandbox") {
      throw providerUnavailable(
        "Coinbase Onramp production orders require real agreement/OTP verification timestamps, which are not implemented yet.",
        { provider: this.id }
      );
    }
    if (!input.email || !input.phone) {
      throw badRequest(
        "Coinbase Onramp requires the counterparty to have an email and phone number.",
        { provider: this.id }
      );
    }

    const now = new Date().toISOString();
    const partnerUserRef = `sandbox-${input.externalCustomerId}`;
    // Coinbase wants strict E.164; strip any formatting the counterparty phone was stored with.
    const phoneNumber = input.phone.replace(/[\s()-]/g, "");

    const { order, paymentLink } = await this.request<CoinbaseCreateOrderResponse>(
      env,
      "POST",
      CDP_V2_ORDERS_URL,
      {
        paymentCurrency: input.fiatCurrency ?? "USD",
        purchaseCurrency: input.cryptoToken,
        paymentMethod: ONRAMP_PAYMENT_METHOD,
        destinationAddress: input.destinationWalletAddress,
        destinationNetwork: SOLANA_NETWORK,
        paymentAmount: input.fiatAmount,
        email: input.email,
        phoneNumber,
        agreementAcceptedAt: now,
        phoneNumberVerifiedAt: now,
        partnerUserRef,
      }
    );

    const hostedUrl = new URL(paymentLink.url);
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
