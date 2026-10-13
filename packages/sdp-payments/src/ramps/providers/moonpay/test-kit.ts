import type { RampProviderTestKit } from "../../test-kit";

const SANDBOX_API_KEY = "pk_test_contract";
const LIVE_API_KEY = "pk_live_contract";
// biome-ignore lint/security/noSecrets: a public wallet address, not a credential.
const WALLET = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";
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

/**
 * MoonPay's contract kit. Estimates are HTTP reads; quotes are signed widget
 * URLs built locally, so they record no exchange.
 */
export const MOONPAY_TEST_KIT: RampProviderTestKit = {
  env: {
    MOONPAY_SANDBOX_API_KEY: SANDBOX_API_KEY,
    MOONPAY_SANDBOX_SECRET_KEY: "sk_test_contract",
    MOONPAY_API_KEY: LIVE_API_KEY,
    MOONPAY_SECRET_KEY: "sk_live_contract",
  },
  onramp: {
    estimate: {
      input: { assetRail: "sol.solana", fiatCurrency: "USD", fiatAmount: "50" },
      exchanges: [
        { method: "GET", url: /\/v3\/currencies\/sol\/buy_quote\?/, status: 200, body: BUY_QUOTE },
      ],
    },
    quote: {
      input: {
        assetRail: "sol.solana",
        fiatCurrency: "USD",
        fiatAmount: "50",
        destinationWalletAddress: WALLET,
        externalCustomerId: "cpty_contract_onramp",
        paymentTransferId: TRANSFER_ID,
      },
      exchanges: [],
    },
  },
  offramp: {
    estimate: {
      input: { assetRail: "sol.solana", fiatCurrency: "USD", cryptoAmount: "1" },
      exchanges: [
        {
          method: "GET",
          url: /\/v3\/currencies\/sol\/sell_quote\?/,
          status: 200,
          body: SELL_QUOTE,
        },
      ],
    },
    quote: {
      input: {
        assetRail: "sol.solana",
        fiatCurrency: "USD",
        cryptoAmount: "1",
        sourceWalletAddress: WALLET,
        externalCustomerId: "cpty_contract_offramp",
        paymentTransferId: TRANSFER_ID,
      },
      exchanges: [],
    },
  },
  usesModeCredential: (request, mode) =>
    new URL(request.url).searchParams.get("apiKey") ===
    (mode === "sandbox" ? SANDBOX_API_KEY : LIVE_API_KEY),
  malformedEstimate: {
    direction: "onramp",
    exchange: {
      method: "GET",
      url: /\/buy_quote\?/,
      status: 200,
      body: { ...BUY_QUOTE, feeAmount: "1.5" },
    },
  },
};
