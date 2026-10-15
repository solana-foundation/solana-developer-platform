import { basicAuthHeader } from "../../shared";
import { CONTRACT_WALLET, type RampProviderTestKit, type RecordedExchange } from "../../test-kit";

const SECRET_KEY = "sk_test_contract";
const FIAT_AMOUNT = "100";
const CUSTOMER_ID = "cpty_contract_onramp";
const CUSTOMER_IP = "203.0.113.7";

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

const QUOTES_EXCHANGE: RecordedExchange = {
  method: "GET",
  url: /^https:\/\/api\.stripe\.com\/v1\/crypto\/onramp\/quotes\?/,
  query: {
    source_amount: FIAT_AMOUNT,
    source_currency: "usd",
    "destination_currencies[]": "usdc",
    "destination_networks[]": "solana",
  },
  status: 200,
  body: QUOTES,
};

/** The terms a Stripe session echoes for the kit's quote, as Stripe formats them. */
export const STRIPE_SESSION_TERMS = {
  destination_amount: null,
  destination_currencies: ["usdc"],
  destination_currency: "usdc",
  destination_network: "solana",
  destination_networks: ["solana"],
  fees: null,
  lock_wallet_address: true,
  source_amount: "100.00",
  source_currency: "usd",
  transaction_id: null,
  wallet_address: null,
  wallet_addresses: { ethereum: null, solana: CONTRACT_WALLET, destination_tags: null },
};

/**
 * The kit's quote exchange, answered with a session that echoes `terms`, as
 * `POST /v1/crypto/onramp_sessions` does.
 */
export function stripeSessionExchange(terms: typeof STRIPE_SESSION_TERMS): RecordedExchange {
  return {
    method: "POST",
    url: /^https:\/\/api\.stripe\.com\/v1\/crypto\/onramp_sessions$/,
    form: {
      "wallet_addresses[solana]": CONTRACT_WALLET,
      lock_wallet_address: "true",
      source_amount: FIAT_AMOUNT,
      source_currency: "usd",
      destination_currency: "usdc",
      destination_network: "solana",
      "destination_currencies[]": "usdc",
      "destination_networks[]": "solana",
      customer_ip_address: CUSTOMER_IP,
      "metadata[externalCustomerId]": CUSTOMER_ID,
    },
    status: 200,
    body: {
      id: "cos_contract",
      object: "crypto.onramp_session",
      client_secret: "cos_contract_secret_abc",
      status: "initialized",
      redirect_url: null,
      transaction_details: terms,
    },
  };
}

/**
 * Stripe's contract kit. Stripe runs onramp only, and one secret key serves
 * both modes: a `sk_test_` key is what makes a request sandbox.
 */
export const STRIPE_TEST_KIT: RampProviderTestKit = {
  env: { STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_PUBLISHABLE_KEY: "pk_test_contract" },
  onramp: {
    estimate: {
      input: { assetRail: "usdc.solana", fiatCurrency: "USD", fiatAmount: FIAT_AMOUNT },
      exchanges: [QUOTES_EXCHANGE],
    },
    quote: {
      input: {
        assetRail: "usdc.solana",
        fiatCurrency: "USD",
        fiatAmount: FIAT_AMOUNT,
        destinationWalletAddress: CONTRACT_WALLET,
        externalCustomerId: CUSTOMER_ID,
        customerIpAddress: CUSTOMER_IP,
      },
      exchanges: [stripeSessionExchange(STRIPE_SESSION_TERMS)],
    },
  },
  usesModeCredential: (request) =>
    request.headers.get("Authorization") === basicAuthHeader(SECRET_KEY, ""),
  malformedEstimate: {
    direction: "onramp",
    exchange: {
      ...QUOTES_EXCHANGE,
      body: {
        ...QUOTES,
        destination_network_quotes: { solana: [{ ...USDC_QUOTE, destination_amount: 96.5 }] },
      },
    },
  },
};
