import { createHmac } from "node:crypto";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types";
import { CONTRACT_WALLET, type RampProviderTestKit, type RecordedExchange } from "../../test-kit";

const API_KEYS = {
  sandbox: "pk_test_contract",
  production: "pk_live_contract",
} as const satisfies Record<SdpEnvironment, string>;

const SECRET_KEYS = {
  sandbox: "sk_test_contract",
  production: "sk_live_contract",
} as const satisfies Record<SdpEnvironment, string>;

/** The widget hosts a hosted quote may point at, by mode. */
const WIDGET_HOSTS = {
  sandbox: ["buy-sandbox.moonpay.com", "sell-sandbox.moonpay.com"],
  production: ["buy.moonpay.com", "sell.moonpay.com"],
} as const satisfies Record<SdpEnvironment, readonly string[]>;

const TRANSFER_ID = "xfr_0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

/** A MoonPay v3 buy quote, as `GET /v3/currencies/sol/buy_quote` answers. */
const BUY_QUOTE = {
  baseCurrencyAmount: 50,
  quoteCurrencyAmount: 0.3,
  quoteCurrencyPrice: 150,
  feeAmount: 1.5,
  networkFeeAmount: 0.1,
  extraFeeAmount: 0,
  baseCurrencyCode: "usd",
  quoteCurrencyCode: "sol",
};

const BUY_QUOTE_EXCHANGE: RecordedExchange = {
  method: "GET",
  url: /^https:\/\/api\.moonpay\.com\/v3\/currencies\/sol\/buy_quote\?/,
  query: { baseCurrencyCode: "usd", baseCurrencyAmount: "50" },
  status: 200,
  body: BUY_QUOTE,
};

/** A MoonPay v3 sell quote, as `GET /v3/currencies/sol/sell_quote` answers. */
const SELL_QUOTE = {
  baseCurrencyAmount: 1,
  quoteCurrencyAmount: 148.2,
  baseCurrencyPrice: 150,
  feeAmount: 1.5,
  extraFeeAmount: 0.3,
  baseCurrencyCode: "sol",
  quoteCurrencyCode: "usd",
};

const SELL_QUOTE_EXCHANGE: RecordedExchange = {
  method: "GET",
  url: /^https:\/\/api\.moonpay\.com\/v3\/currencies\/sol\/sell_quote\?/,
  query: { quoteCurrencyCode: "usd", baseCurrencyAmount: "1" },
  status: 200,
  body: SELL_QUOTE,
};

/**
 * Whether a widget URL is on `mode`'s host with `mode`'s key and signature.
 * The signature is recomputed here as MoonPay checks it: an HMAC-SHA256 of the
 * query without it, keyed by the mode's secret.
 */
function signedForMode(hostedUrl: string, mode: SdpEnvironment): boolean {
  const url = new URL(hostedUrl);
  const signature = url.searchParams.get("signature");
  url.searchParams.delete("signature");
  return (
    WIDGET_HOSTS[mode].some((host) => host === url.host) &&
    url.searchParams.get("apiKey") === API_KEYS[mode] &&
    signature === createHmac("sha256", SECRET_KEYS[mode]).update(url.search).digest("base64")
  );
}

/**
 * MoonPay's contract kit. Estimates are HTTP reads; quotes are signed widget
 * URLs built locally, so they record no exchange and are checked by URL.
 */
export const MOONPAY_TEST_KIT: RampProviderTestKit = {
  env: {
    MOONPAY_SANDBOX_API_KEY: API_KEYS.sandbox,
    MOONPAY_SANDBOX_SECRET_KEY: SECRET_KEYS.sandbox,
    MOONPAY_API_KEY: API_KEYS.production,
    MOONPAY_SECRET_KEY: SECRET_KEYS.production,
  },
  managedModes: SDP_ENVIRONMENTS,
  onramp: {
    estimate: {
      input: { assetRail: "sol.solana", fiatCurrency: "USD", fiatAmount: "50" },
      exchanges: [BUY_QUOTE_EXCHANGE],
    },
    quote: {
      input: {
        assetRail: "sol.solana",
        fiatCurrency: "USD",
        fiatAmount: "50",
        destinationWalletAddress: CONTRACT_WALLET,
        externalCustomerId: "cpty_contract_onramp",
        paymentTransferId: TRANSFER_ID,
      },
      exchanges: [],
    },
  },
  offramp: {
    estimate: {
      input: { assetRail: "sol.solana", fiatCurrency: "USD", cryptoAmount: "1" },
      exchanges: [SELL_QUOTE_EXCHANGE],
    },
    quote: {
      input: {
        assetRail: "sol.solana",
        fiatCurrency: "USD",
        cryptoAmount: "1",
        sourceWalletAddress: CONTRACT_WALLET,
        externalCustomerId: "cpty_contract_offramp",
        paymentTransferId: TRANSFER_ID,
      },
      exchanges: [],
    },
  },
  usesModeCredential: (request, mode) =>
    new URL(request.url).searchParams.get("apiKey") === API_KEYS[mode],
  quoteUsesModeCredential: (quote, mode) =>
    quote.deliveryMode === "hosted" && signedForMode(quote.hostedUrl, mode),
  malformedEstimate: {
    direction: "onramp",
    exchange: { ...BUY_QUOTE_EXCHANGE, body: { ...BUY_QUOTE, feeAmount: "1.5" } },
  },
};
