import { basicAuthHeader } from "#/ramps/shared";
import {
  CONTRACT_DELIVERY_SIGNATURE,
  CONTRACT_WALLET,
  type RampProviderTestKit,
  type RecordedExchange,
} from "#/ramps/test-kit";

const SECRET_KEY = "sk_test_contract";
const FIAT_AMOUNT = "100";
const STRIPE_TRANSFER_ID = "xfr_5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
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

/** The kit's session once Stripe delivered it, as the sandbox reports a completed one. */
export const STRIPE_COMPLETED_SESSION = {
  id: "cos_contract",
  object: "crypto.onramp_session",
  client_secret: "cos_contract_secret_abc",
  livemode: false,
  status: "fulfillment_complete",
  redirect_url: null,
  transaction_details: {
    ...STRIPE_SESSION_TERMS,
    destination_amount: "96.500000",
    transaction_id: CONTRACT_DELIVERY_SIGNATURE,
    wallet_address: CONTRACT_WALLET,
  },
};

/** The kit's session lookup answered with `session`, as `GET /v1/crypto/onramp_sessions/{id}`. */
export function stripeSessionLookupExchange(
  status: number,
  session: Record<string, unknown>
): RecordedExchange {
  return {
    method: "GET",
    url: /^https:\/\/api\.stripe\.com\/v1\/crypto\/onramp_sessions\/cos_contract$/,
    status,
    body: session,
  };
}

/** Stripe's contract kit. Stripe runs onramp only. */
export const STRIPE_TEST_KIT: RampProviderTestKit = {
  credentials: { publicKey: "pk_test_contract", secretKey: SECRET_KEY },
  liveCredentials: { publicKey: "pk_live_contract", secretKey: "sk_live_contract" },
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
  transferStatus: {
    "a completed session": {
      input: {
        transferId: STRIPE_TRANSFER_ID,
        rampType: "onramp",
        providerReference: "cos_contract",
      },
      exchanges: [stripeSessionLookupExchange(200, STRIPE_COMPLETED_SESSION)],
      events: [
        {
          provider: "stripe",
          kind: "settled",
          reference: "cos_contract",
          deliveredAssetRail: "usdc.solana",
          receivedAmount: "96.500000",
          onchain: { signature: CONTRACT_DELIVERY_SIGNATURE, destinationAddress: CONTRACT_WALLET },
        },
      ],
    },
    "a session awaiting payment": {
      input: {
        transferId: STRIPE_TRANSFER_ID,
        rampType: "onramp",
        providerReference: "cos_contract",
      },
      exchanges: [
        stripeSessionLookupExchange(200, {
          ...STRIPE_COMPLETED_SESSION,
          status: "requires_payment",
          transaction_details: STRIPE_SESSION_TERMS,
        }),
      ],
      events: [{ provider: "stripe", kind: "awaiting_payment", reference: "cos_contract" }],
    },
  },
  usesCredentials: (request) =>
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
