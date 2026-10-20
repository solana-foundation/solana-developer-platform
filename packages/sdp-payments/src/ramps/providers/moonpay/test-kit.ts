import { createHmac } from "node:crypto";
import type { RampTransferType } from "@sdp/types/payments";
import {
  CONTRACT_DELIVERY_SIGNATURE,
  CONTRACT_WALLET,
  type RampProviderTestKit,
  type RecordedExchange,
} from "#/ramps/test-kit";
import type { MoonpaySettlementEvent } from "./event-status-mapping";

const API_KEY = "pk_test_contract";
const SECRET_KEY = "sk_test_contract";

/** The widget hosts a hosted sandbox quote may point at. */
const WIDGET_HOSTS = ["buy-sandbox.moonpay.com", "sell-sandbox.moonpay.com"];

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

const CUSTOMER_ID = "55ee219b-1a3f-4770-8b85-5ce022c1c0d1";

// biome-ignore lint/security/noSecrets: a public MoonPay deposit wallet, not a credential.
const DEPOSIT_WALLET = "NEQhyijWMWBYq1khA2YaeG6FyxMBVMbnFsasxa9DZvU";

/** A completed buy, as `GET /v1/transactions/ext/{id}` lists it (the sandbox, 2026-10-19). */
export const MOONPAY_COMPLETED_BUY = {
  id: "6d7bbaad-aa72-44f5-8f37-43cf68c701e8",
  createdAt: "2026-08-31T05:29:52.682Z",
  updatedAt: "2026-08-31T05:30:01.390Z",
  status: "completed",
  flow: "principal",
  externalTransactionId: TRANSFER_ID,
  externalCustomerId: "cpty_contract_onramp",
  customerId: CUSTOMER_ID,
  walletAddress: CONTRACT_WALLET,
  cryptoTransactionId: CONTRACT_DELIVERY_SIGNATURE,
  failureReason: null,
  baseCurrencyAmount: 50,
  quoteCurrencyAmount: 0.3,
  feeAmount: 1.5,
  extraFeeAmount: 0,
  networkFeeAmount: 0.1,
  areFeesIncluded: false,
  usdRate: 1,
  baseCurrency: { code: "usd", type: "fiat" },
  currency: { code: "sol", type: "crypto" },
  stages: [{ stage: "stage_four_delivery", status: "success" }],
};

/** A sale waiting for its deposit, as `GET /v3/sell_transactions/ext/{id}` lists it. */
export const MOONPAY_SALE_AWAITING_DEPOSIT = {
  id: "8c52cc05-0cb0-4614-8baa-16bdfaa18b8e",
  createdAt: "2026-09-04T08:26:21.599Z",
  updatedAt: "2026-09-04T08:26:40.120Z",
  status: "waitingForDeposit",
  flow: "principal",
  externalTransactionId: TRANSFER_ID,
  externalCustomerId: "cpty_contract_offramp",
  customerId: CUSTOMER_ID,
  baseCurrencyAmount: 1,
  quoteCurrencyAmount: 148.2,
  refundWalletAddress: CONTRACT_WALLET,
  depositHash: null,
  depositWallet: { walletAddress: DEPOSIT_WALLET, walletAddressTag: null },
  failureReason: null,
  baseCurrency: { code: "sol", type: "crypto" },
  quoteCurrency: { code: "usd", type: "fiat" },
  stages: [{ stage: "sell_stage_two_waiting_for_deposit", status: "in_progress" }],
};

/** The event the webhook path makes of `MOONPAY_COMPLETED_BUY`. */
const MOONPAY_COMPLETED_BUY_EVENT: MoonpaySettlementEvent = {
  provider: "moonpay",
  kind: "settled",
  reference: MOONPAY_COMPLETED_BUY.id,
  transferId: TRANSFER_ID,
  rampType: "onramp",
  providerObservedAt: MOONPAY_COMPLETED_BUY.updatedAt,
  providerCustomerId: CUSTOMER_ID,
  receivedAmount: "0.3",
  deliveredAssetRail: "sol.solana",
  onchain: {
    signature: CONTRACT_DELIVERY_SIGNATURE,
    destinationAddress: CONTRACT_WALLET,
    amount: "0.3",
  },
  settlement: {
    provider: "moonpay",
    status: "completed",
    transactionId: MOONPAY_COMPLETED_BUY.id,
    baseCurrencyCode: "USD",
    baseCurrencyAmount: 50,
    quoteCurrencyCode: "SOL",
    quoteCurrencyAmount: 0.3,
    feeAmount: 1.5,
    extraFeeAmount: 0,
    networkFeeAmount: 0.1,
    areFeesIncluded: false,
    usdRate: 1,
    cryptoTransactionId: CONTRACT_DELIVERY_SIGNATURE,
  },
};

/** The event the webhook path makes of `MOONPAY_SALE_AWAITING_DEPOSIT`. */
const MOONPAY_SALE_AWAITING_DEPOSIT_EVENT: MoonpaySettlementEvent = {
  provider: "moonpay",
  kind: "awaiting_payment",
  reference: MOONPAY_SALE_AWAITING_DEPOSIT.id,
  transferId: TRANSFER_ID,
  rampType: "offramp",
  providerObservedAt: MOONPAY_SALE_AWAITING_DEPOSIT.updatedAt,
  providerCustomerId: CUSTOMER_ID,
  cryptoDeposit: { destinationAddress: DEPOSIT_WALLET, amount: "1" },
};

/** MoonPay's answer to an external id it holds no transaction for (the sandbox, 2026-10-19). */
const TRANSACTION_NOT_FOUND = {
  errors: [],
  message: "Transaction not found",
  moonPayErrorCode: "1_SYS_UNKNOWN",
  type: "NotFoundError",
};

/** The external-id lookup for the kit's transfer in `rampType`'s direction. */
export function moonpayLookupExchange(
  rampType: RampTransferType,
  status: number,
  body: RecordedExchange["body"]
): RecordedExchange {
  const path = rampType === "onramp" ? "v1/transactions" : "v3/sell_transactions";
  return {
    method: "GET",
    url: new RegExp(`^https://api\\.moonpay\\.com/${path}/ext/${TRANSFER_ID}\\?`),
    status,
    body,
  };
}

/**
 * Whether a widget URL is on `mode`'s host with `mode`'s key and signature.
 * The signature is recomputed here as MoonPay checks it: an HMAC-SHA256 of the
 * query without it, keyed by the mode's secret.
 */
function signedWithSandboxKeys(hostedUrl: string): boolean {
  const url = new URL(hostedUrl);
  const signature = url.searchParams.get("signature");
  url.searchParams.delete("signature");
  return (
    WIDGET_HOSTS.some((host) => host === url.host) &&
    url.searchParams.get("apiKey") === API_KEY &&
    signature === createHmac("sha256", SECRET_KEY).update(url.search).digest("base64")
  );
}

/**
 * MoonPay's contract kit. Estimates and status lookups are HTTP reads; quotes
 * are signed widget URLs built locally, so they record no exchange and are
 * checked by URL.
 */
export const MOONPAY_TEST_KIT: RampProviderTestKit = {
  env: { MOONPAY_SANDBOX_API_KEY: API_KEY, MOONPAY_SANDBOX_SECRET_KEY: SECRET_KEY },
  managedModes: ["sandbox"],
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
  transferStatus: {
    "a completed buy": {
      input: { transferId: TRANSFER_ID, rampType: "onramp", providerReference: null },
      exchanges: [moonpayLookupExchange("onramp", 200, [MOONPAY_COMPLETED_BUY])],
      events: [MOONPAY_COMPLETED_BUY_EVENT],
    },
    "a sale awaiting its deposit": {
      input: { transferId: TRANSFER_ID, rampType: "offramp", providerReference: null },
      exchanges: [moonpayLookupExchange("offramp", 200, [MOONPAY_SALE_AWAITING_DEPOSIT])],
      events: [MOONPAY_SALE_AWAITING_DEPOSIT_EVENT],
    },
    "a transfer MoonPay holds nothing for": {
      input: { transferId: TRANSFER_ID, rampType: "onramp", providerReference: null },
      exchanges: [moonpayLookupExchange("onramp", 404, TRANSACTION_NOT_FOUND)],
      events: [],
    },
  },
  usesModeCredential: (request) => new URL(request.url).searchParams.get("apiKey") === API_KEY,
  quoteUsesModeCredential: (quote) =>
    quote.deliveryMode === "hosted" && signedWithSandboxKeys(quote.hostedUrl),
  malformedEstimate: {
    direction: "onramp",
    exchange: { ...BUY_QUOTE_EXCHANGE, body: { ...BUY_QUOTE, feeAmount: "1.5" } },
  },
};
