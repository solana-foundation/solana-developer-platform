import {
  CONTRACT_DELIVERY_SIGNATURE,
  CONTRACT_WALLET,
  type RampProviderTestKit,
  type RecordedExchange,
} from "#/ramps/test-kit";

const CLIENT_ID = "hpk_test_ContractClientId000001";
const FIAT_AMOUNT = "100";
const ACCOUNT_ID = "acct_contract_business";
const ORDER_ID = "ord_contract_onramp";
const HERCLE_TRANSFER_ID = "xfr_7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

/** A placeholder in the shape of an SPKI PEM: only its format is checked. */
function webhookPublicKey(label: string): string {
  return `-----BEGIN PUBLIC KEY-----\n${label}\n-----END PUBLIC KEY-----\n`;
}

/** Hercle's estimate, as `POST /partner/v1/quotes/estimate` answers: the fee is inside the fiat. */
const ESTIMATE = {
  fiatCurrency: "EUR",
  fiatAmount: "100.00",
  cryptoAmount: "98.765432",
  exchangeRate: "1.002375",
  fees: { currency: "EUR", total: "1.00" },
  minFiatAmount: "10.00",
  maxFiatAmount: "100000.00",
  expiresAt: "2026-10-30T10:00:15Z",
};

const ESTIMATE_EXCHANGE: RecordedExchange = {
  method: "POST",
  url: /^https:\/\/publicapi\.sandbox\.hercle\.financial\/partner\/v1\/quotes\/estimate$/,
  status: 200,
  body: ESTIMATE,
};

/** Hercle's order, as `POST /partner/v1/orders/onramp` answers. */
export const HERCLE_ORDER = {
  orderId: ORDER_ID,
  fiatCurrency: "EUR",
  fiatAmount: "100.00",
  bankAccount: {
    // biome-ignore lint/security/noSecrets: a public sample IBAN, not a credential.
    iban: "CH9300762011623852957",
    bic: "HRCLCHZZ",
    bankName: "Contract Bank",
    accountHolder: "Hercle SA",
    paymentReference: "HRC-ORD-CONTRACT",
    payerAccountHolder: "Contract Business AG",
  },
  expiresAt: "2026-10-30T10:15:00Z",
};

/** The kit's order lookup answered with `body`, as `GET /partner/v1/orders/{id}`. */
function orderLookupExchange(status: number, body: Record<string, unknown>): RecordedExchange {
  return {
    method: "GET",
    url: /^https:\/\/publicapi\.sandbox\.hercle\.financial\/partner\/v1\/orders\/ord_contract_onramp$/,
    status,
    body,
  };
}

const ORDER_READ = {
  orderId: ORDER_ID,
  direction: "onramp",
  fiatCurrency: "EUR",
  fiatAmount: "100.00",
  cryptoAsset: "USDC",
  cryptoAmount: "98.765432",
  reference: "HRC-ORD-CONTRACT",
  error: null,
};

const ORDER_LOOKUP = {
  transferId: HERCLE_TRANSFER_ID,
  rampType: "onramp",
  providerReference: ORDER_ID,
} as const;

/**
 * Hercle's sandbox answer to `GET /partner/v1/orders/{id}` for an id it holds nothing for, recorded on 2026-11-04.
 * Only the trace id is replaced. The sandbox gave the same answer for an order it had settled the day before.
 */
const ORDER_NOT_FOUND = {
  code: "ORDER_NOT_FOUND",
  message: "Order not found",
  traceId: "trace_contract",
};

/**
 * Hercle's sandbox refusals of the same lookup, recorded on 2026-11-04 with the trace id replaced.
 * Each one is a failure to ask, never an order Hercle does not hold.
 */
export const HERCLE_ORDER_LOOKUP_REFUSALS = {
  "a request signed outside Hercle's 300-second window": orderLookupExchange(401, {
    code: "AUTH_STALE_TIMESTAMP",
    message: "Timestamp outside the ±300s window",
    traceId: "trace_contract",
  }),
  "a request signed with another secret": orderLookupExchange(401, {
    code: "AUTH_INVALID_SIGNATURE",
    message: "Invalid signature",
    traceId: "trace_contract",
  }),
} satisfies Record<string, RecordedExchange>;

/** Hercle's contract kit. Hercle runs onramp only, and every order acts for a business account. */
export const HERCLE_TEST_KIT: RampProviderTestKit = {
  credentials: {
    publicKey: CLIENT_ID,
    secretKey: "ContractSecretKey00000000000000000000000000",
  },
  liveCredentials: {
    publicKey: "hpk_live_ContractClientId000001",
    secretKey: "LiveContractSecretKey0000000000000000000000",
  },
  webhookSecrets: {
    sandbox: webhookPublicKey("contract-sandbox"),
    production: webhookPublicKey("contract-production"),
  },
  onramp: {
    estimate: {
      input: { assetRail: "usdc.solana", fiatCurrency: "EUR", fiatAmount: FIAT_AMOUNT },
      exchanges: [ESTIMATE_EXCHANGE],
    },
    quote: {
      input: {
        assetRail: "usdc.solana",
        fiatCurrency: "EUR",
        fiatAmount: FIAT_AMOUNT,
        destinationWalletAddress: CONTRACT_WALLET,
        externalCustomerId: ACCOUNT_ID,
        paymentTransferId: HERCLE_TRANSFER_ID,
      },
      exchanges: [
        {
          method: "POST",
          url: /^https:\/\/publicapi\.sandbox\.hercle\.financial\/partner\/v1\/orders\/onramp$/,
          status: 200,
          body: HERCLE_ORDER,
        },
      ],
    },
  },
  transferStatus: {
    "a settled order": {
      input: ORDER_LOOKUP,
      exchanges: [orderLookupExchange(200, { ...ORDER_READ, status: "settled" })],
      events: [{ provider: "hercle", kind: "settled", reference: ORDER_ID }],
    },
    "a settled order naming its delivery": {
      input: ORDER_LOOKUP,
      exchanges: [
        orderLookupExchange(200, {
          ...ORDER_READ,
          status: "settled",
          destinationWalletAddress: CONTRACT_WALLET,
          txHash: CONTRACT_DELIVERY_SIGNATURE,
        }),
      ],
      events: [
        {
          provider: "hercle",
          kind: "settled",
          reference: ORDER_ID,
          onchain: { signature: CONTRACT_DELIVERY_SIGNATURE, destinationAddress: CONTRACT_WALLET },
        },
      ],
    },
    "an order awaiting its wire": {
      input: ORDER_LOOKUP,
      exchanges: [orderLookupExchange(200, { ...ORDER_READ, status: "awaiting_payment" })],
      events: [{ provider: "hercle", kind: "awaiting_payment", reference: ORDER_ID }],
    },
    "an order failed for a third-party payer": {
      input: ORDER_LOOKUP,
      exchanges: [
        orderLookupExchange(200, { ...ORDER_READ, status: "failed", error: "THIRD_PARTY_PAYER" }),
      ],
      events: [
        {
          provider: "hercle",
          kind: "failed",
          reference: ORDER_ID,
          error: "The wire came from an account other than the business's own.",
        },
      ],
    },
    "an order Hercle does not hold": {
      input: ORDER_LOOKUP,
      exchanges: [orderLookupExchange(404, ORDER_NOT_FOUND)],
      events: [],
    },
  },
  usesCredentials: (request) =>
    request.headers.get("X-Hercle-Client") === CLIENT_ID &&
    request.headers.get("X-Hercle-Signature") !== null &&
    request.headers.get("X-Hercle-Ts") !== null,
  malformedEstimate: {
    direction: "onramp",
    exchange: { ...ESTIMATE_EXCHANGE, body: { ...ESTIMATE, cryptoAmount: 98.765432 } },
  },
};
