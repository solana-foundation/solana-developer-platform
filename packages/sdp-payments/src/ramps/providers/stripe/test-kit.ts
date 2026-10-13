import { basicAuthHeader } from "../../shared";
import type { RampProviderTestKit } from "../../test-kit";

const SECRET_KEY = "sk_test_contract";
// biome-ignore lint/security/noSecrets: a public wallet address, not a credential.
const WALLET = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";

const USDC_QUOTE = {
  id: "q_usdc",
  destination_network: "solana",
  destination_currency: "usdc",
  destination_amount: "96.500000",
  fees: { network_fee_monetary: "0.01", transaction_fee_monetary: "3.49" },
  source_total_amount: "100.00",
};

/** Stripe's onramp quotes, as `GET /v1/crypto/onramp/quotes` answers. */
const QUOTES = {
  id: "quote_set_contract",
  object: "crypto.onramp.quotes",
  source_amount: "96.50",
  source_currency: "usd",
  rate_fetched_at: 1719947634,
  destination_network_quotes: { solana: [USDC_QUOTE] },
};

/** A Stripe onramp session, as `POST /v1/crypto/onramp_sessions` answers. */
const SESSION = {
  id: "cos_contract",
  object: "crypto.onramp_session",
  client_secret: "cos_contract_secret_abc",
  status: "initialized",
  redirect_url: null,
};

/**
 * Stripe's contract kit. Stripe runs onramp only, and one secret key serves
 * both modes: a `sk_test_` key is what makes a request sandbox.
 */
export const STRIPE_TEST_KIT: RampProviderTestKit = {
  env: { STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_PUBLISHABLE_KEY: "pk_test_contract" },
  onramp: {
    estimate: {
      input: { assetRail: "usdc.solana", fiatCurrency: "USD", fiatAmount: "100" },
      exchanges: [
        { method: "GET", url: /\/v1\/crypto\/onramp\/quotes\?/, status: 200, body: QUOTES },
      ],
    },
    quote: {
      input: {
        assetRail: "usdc.solana",
        fiatCurrency: "USD",
        fiatAmount: "100",
        destinationWalletAddress: WALLET,
        externalCustomerId: "cpty_contract_onramp",
        customerIpAddress: "203.0.113.7",
      },
      exchanges: [
        { method: "POST", url: /\/v1\/crypto\/onramp_sessions$/, status: 200, body: SESSION },
      ],
    },
  },
  usesModeCredential: (request) =>
    request.headers.get("Authorization") === basicAuthHeader(SECRET_KEY, ""),
  malformedEstimate: {
    direction: "onramp",
    exchange: {
      method: "GET",
      url: /\/v1\/crypto\/onramp\/quotes\?/,
      status: 200,
      body: {
        ...QUOTES,
        destination_network_quotes: { solana: [{ ...USDC_QUOTE, destination_amount: 96.5 }] },
      },
    },
  },
};
