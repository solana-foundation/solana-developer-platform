import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { Counterparty, PaymentRampEstimate, PaymentRampQuote } from "@sdp/types";
import { getCryptoRailAssetLabel, parseFiatCurrency } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { AppError, badRequest, providerNotConfigured } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { providerFetchJson } from "../fetch";
import { readyCounterparty } from "../requirements";
import {
  createProviderRampSupport,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
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

// `onramp.transaction.updated` carries a lifecycle status; terminal state may instead arrive as a
// discrete `onramp.transaction.success` / `.failed` event. Unmapped statuses/events are ignored.
const COINBASE_ORDER_STATUS = {
  ONRAMP_ORDER_STATUS_PENDING_AUTH: "settling",
  ONRAMP_ORDER_STATUS_PENDING_PAYMENT: "settling",
  ONRAMP_ORDER_STATUS_PROCESSING: "settling",
  ONRAMP_ORDER_STATUS_COMPLETED: "settled",
  ONRAMP_ORDER_STATUS_FAILED: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

function coinbaseSettlementKind(
  eventType: string,
  status: string | undefined
): "settling" | "settled" | "failed" | undefined {
  switch (eventType) {
    case "onramp.transaction.success":
      return "settled";
    case "onramp.transaction.failed":
      return "failed";
    default:
      return status
        ? COINBASE_ORDER_STATUS[status as keyof typeof COINBASE_ORDER_STATUS]
        : undefined;
  }
}

// TODO(coinbase): type against real onramp.transaction.* samples before production.
interface CoinbaseOnrampWebhookEvent {
  eventType: string;
  data: {
    orderId: string;
    status?: string;
    purchaseAmount?: CoinbaseAmount;
    failureReason?: string;
  };
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

  async validateWebhook({
    env,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<RampWebhookValidationResult> {
    // Coinbase uses one webhook signing secret across environments (not mode-keyed).
    const webhookSecret = env.COINBASE_CDP_RAMPS_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      throw providerNotConfigured(
        "Coinbase webhook secret is not configured (COINBASE_CDP_RAMPS_WEBHOOK_SECRET)."
      );
    }

    const signatureHeader = headers.get("x-hook0-signature")?.trim();
    if (!signatureHeader) {
      throw new AppError("UNAUTHORIZED", "Coinbase webhook is missing X-Hook0-Signature header", {
        provider: this.id,
      });
    }

    const fields = new Map(
      signatureHeader.split(",").map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
      })
    );
    const timestamp = fields.get("t");
    const signature = fields.get("v0");
    if (!timestamp || !signature) {
      throw new AppError("UNAUTHORIZED", "Coinbase webhook signature header is malformed", {
        provider: this.id,
      });
    }

    await verifyWebhookSignature({
      provider: this.id,
      signedPayload: `${timestamp}.${rawBody}`,
      signature,
      algorithm: {
        type: "hmac-sha256",
        secret: webhookSecret,
        encoding: "hex",
      },
      timestampSeconds: Number(timestamp),
    });

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw badRequest("Coinbase webhook body must be valid JSON", { provider: this.id });
    }
    return { provider: this.id, payload };
  }

  parseSettlementEvent(payload: unknown): RampSettlementEvent {
    const { eventType, data } = payload as CoinbaseOnrampWebhookEvent;
    if (!eventType?.startsWith("onramp.transaction.")) {
      return { provider: this.id, kind: "ignore", reason: `unsupported_event:${eventType}` };
    }
    if (!data?.orderId) {
      return { provider: this.id, kind: "ignore", reason: "missing_order_id" };
    }

    const kind = coinbaseSettlementKind(eventType, data.status);
    if (!kind) {
      return { provider: this.id, kind: "ignore", reason: `unhandled:${eventType}:${data.status}` };
    }
    const reference = data.orderId;
    if (kind === "failed") {
      return {
        provider: this.id,
        kind,
        reference,
        ...(data.failureReason ? { error: data.failureReason } : {}),
      };
    }
    if (kind === "settled") {
      return {
        provider: this.id,
        kind,
        reference,
        ...(data.purchaseAmount ? { receivedAmount: data.purchaseAmount.value } : {}),
      };
    }
    return { provider: this.id, kind, reference };
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

  async createOnrampQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    if (!input.email || !input.phone) {
      throw badRequest(
        "Coinbase Onramp requires the counterparty to have an email and phone number.",
        { provider: this.id }
      );
    }
    if (!input.domain) {
      throw badRequest("Coinbase Onramp requires an embedding domain for the Apple Pay link.", {
        provider: this.id,
      });
    }

    const now = new Date().toISOString();
    // Sandbox transactions are flagged by a `sandbox-` prefix on partnerUserRef, not by credentials.
    const partnerUserRef =
      mode === "sandbox" ? `sandbox-${input.externalCustomerId}` : input.externalCustomerId;
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
        // ponytail: sandbox stamps verification now; production must pass real OTP verification ids.
        phoneNumberVerifiedAt: now,
        partnerUserRef,
        domain: input.domain,
      }
    );

    console.log(`[coinbase onramp] order ${order.orderId} → hosted url: ${paymentLink.url}`);

    return {
      provider: this.id,
      id: order.orderId,
      status: "pending",
      deliveryMode: "hosted",
      hostedUrl: paymentLink.url,
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
