import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  moonpayBuyTransactionSchema,
  moonpaySellTransactionSchema,
  moonpaySellTransactionSettlementEvent,
  moonpayTransactionSettlementEvent,
} from "./event-status-mapping";

describe("moonpayTransactionSettlementEvent", () => {
  it("keeps MoonPay's transaction id separate from SDP's correlation id", () => {
    const data = moonpayBuyTransactionSchema.parse({
      id: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
      externalTransactionId: "xfr_157805c4-5d9f-404c-b206-1b59b13b492e",
      status: "pending",
      currency: { code: "sol" },
    });

    assert.deepEqual(moonpayTransactionSettlementEvent(data), {
      provider: "moonpay",
      kind: "settling",
      reference: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
      transferId: "xfr_157805c4-5d9f-404c-b206-1b59b13b492e",
    });
  });

  it("maps the completed buy transaction onto SDP's on-chain transfer fields", () => {
    const data = moonpayBuyTransactionSchema.parse({
      id: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
      externalTransactionId: "xfr_157805c4-5d9f-404c-b206-1b59b13b492e",
      status: "completed",
      currency: { code: "sol" },
      quoteCurrencyAmount: 0.206,
      walletAddress: "FqHmHATxb6esTj7noZE6j7ZTzCqeZjAc9Ao3wfGA6WGP",
      cryptoTransactionId:
        "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM",
    });

    assert.deepEqual(moonpayTransactionSettlementEvent(data), {
      provider: "moonpay",
      kind: "settled",
      reference: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
      transferId: "xfr_157805c4-5d9f-404c-b206-1b59b13b492e",
      receivedAmount: "0.206",
      onchain: {
        signature:
          "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM",
        destinationAddress: "FqHmHATxb6esTj7noZE6j7ZTzCqeZjAc9Ao3wfGA6WGP",
        amount: "0.206",
      },
      deliveredAssetRail: "sol.solana",
    });
  });

  it("reports the crypto bought as the delivered rail, null for one SDP has no rail for", () => {
    const completed = (code: string) =>
      moonpayTransactionSettlementEvent(
        moonpayBuyTransactionSchema.parse({
          id: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
          externalTransactionId: "xfr_157805c4-5d9f-404c-b206-1b59b13b492e",
          status: "completed",
          currency: { code },
        })
      );

    assert.deepEqual(completed("usdc_sol"), {
      provider: "moonpay",
      kind: "settled",
      reference: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
      transferId: "xfr_157805c4-5d9f-404c-b206-1b59b13b492e",
      deliveredAssetRail: "usdc.solana",
    });
    assert.deepEqual(completed("eth"), {
      provider: "moonpay",
      kind: "settled",
      reference: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
      transferId: "xfr_157805c4-5d9f-404c-b206-1b59b13b492e",
      deliveredAssetRail: null,
    });
  });

  it("reports no rail when the transaction does not name its crypto", () => {
    const event = moonpayTransactionSettlementEvent(
      moonpayBuyTransactionSchema.parse({
        id: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
        externalTransactionId: "xfr_157805c4-5d9f-404c-b206-1b59b13b492e",
        status: "completed",
      })
    );
    assert.equal("deliveredAssetRail" in event, false);
  });
});

// Trimmed from a real sandbox `sell_transaction_created` webhook (2026-08-28).
const SDP_TRANSFER_ID = "xfr_c79c556a-0e06-4d77-9b50-6e2e765099ac";
const waitingForDepositPayload = {
  externalCustomerId: "MOONPAY-ONRAMP-0001",
  id: "cca8ef45-4aac-4a91-851a-02ff991eeef9",
  baseCurrencyAmount: 0.2,
  feeAmount: 3.99,
  extraFeeAmount: 0,
  quoteCurrencyAmount: 16.31,
  flow: "principal",
  status: "waitingForDeposit",
  customerId: "55ee219b-1a3f-4770-8b85-5ce022c1c0d1",
  refundWalletAddress: "FqHmHATxb6esTj7noZE6j7ZTzCqeZjAc9Ao3wfGA6WGP",
  externalTransactionId: SDP_TRANSFER_ID,
  baseCurrency: { code: "sol" },
  failureReason: null,
  depositHash: null,
  depositWallet: {
    id: "23b31386-3639-48fd-a413-9fd3ceeb3896",
    walletAddress: "NEQhyijWMWBYq1khA2YaeG6FyxMBVMbnFsasxa9DZvU",
    walletAddressTag: "",
  },
};

function parseSell(payload: unknown) {
  const parsed = moonpaySellTransactionSchema.safeParse(payload);
  assert.ok(parsed.success);
  return parsed.data;
}

describe("moonpaySellTransactionSettlementEvent", () => {
  it("maps waitingForDeposit to awaiting_payment with the deposit instruction", () => {
    const event = moonpaySellTransactionSettlementEvent(parseSell(waitingForDepositPayload));
    assert.deepEqual(event, {
      provider: "moonpay",
      kind: "awaiting_payment",
      reference: "cca8ef45-4aac-4a91-851a-02ff991eeef9",
      transferId: SDP_TRANSFER_ID,
      providerCustomerId: "55ee219b-1a3f-4770-8b85-5ce022c1c0d1",
      cryptoDeposit: {
        destinationAddress: "NEQhyijWMWBYq1khA2YaeG6FyxMBVMbnFsasxa9DZvU",
        amount: "0.2",
      },
    });
  });

  it("maps requoteRequired to awaiting_payment and withdraws the deposit instruction", () => {
    const event = moonpaySellTransactionSettlementEvent(
      parseSell({ ...waitingForDepositPayload, status: "requoteRequired" })
    );
    assert.deepEqual(event, {
      provider: "moonpay",
      kind: "awaiting_payment",
      reference: "cca8ef45-4aac-4a91-851a-02ff991eeef9",
      transferId: SDP_TRANSFER_ID,
      providerCustomerId: "55ee219b-1a3f-4770-8b85-5ce022c1c0d1",
      cryptoDeposit: null,
    });
  });

  it("maps a completed sell deposit onto SDP's on-chain transfer fields", () => {
    const event = moonpaySellTransactionSettlementEvent(
      parseSell({
        ...waitingForDepositPayload,
        status: "completed",
        depositHash:
          "4gYf6JwRXvV9LhJqR6CjvhgpqpNrp41cYwHC1PJNBJdk6FHaaBxTkZQHUnwNi1trGf31FyHg6pQJfUmK4D3kVQnG",
      })
    );

    assert.deepEqual(event, {
      provider: "moonpay",
      kind: "settled",
      reference: "cca8ef45-4aac-4a91-851a-02ff991eeef9",
      transferId: SDP_TRANSFER_ID,
      providerCustomerId: "55ee219b-1a3f-4770-8b85-5ce022c1c0d1",
      receivedAmount: "16.31",
      onchain: {
        signature:
          "4gYf6JwRXvV9LhJqR6CjvhgpqpNrp41cYwHC1PJNBJdk6FHaaBxTkZQHUnwNi1trGf31FyHg6pQJfUmK4D3kVQnG",
        sourceAddress: "FqHmHATxb6esTj7noZE6j7ZTzCqeZjAc9Ao3wfGA6WGP",
        destinationAddress: "NEQhyijWMWBYq1khA2YaeG6FyxMBVMbnFsasxa9DZvU",
        amount: "0.2",
      },
      deliveredAssetRail: "sol.solana",
    });
  });

  it("maps completed to settled with the fiat received amount", () => {
    const event = moonpaySellTransactionSettlementEvent(
      parseSell({ ...waitingForDepositPayload, status: "completed" })
    );
    assert.deepEqual(event, {
      provider: "moonpay",
      kind: "settled",
      reference: "cca8ef45-4aac-4a91-851a-02ff991eeef9",
      transferId: SDP_TRANSFER_ID,
      providerCustomerId: "55ee219b-1a3f-4770-8b85-5ce022c1c0d1",
      receivedAmount: "16.31",
      deliveredAssetRail: "sol.solana",
    });
  });

  it("reports the crypto sold as the rail, null for one SDP has no rail for", () => {
    const completedSale = (code: string) =>
      moonpaySellTransactionSettlementEvent(
        parseSell({ ...waitingForDepositPayload, status: "completed", baseCurrency: { code } })
      );
    const expected = (deliveredAssetRail: string | null) => ({
      provider: "moonpay",
      kind: "settled",
      reference: "cca8ef45-4aac-4a91-851a-02ff991eeef9",
      transferId: SDP_TRANSFER_ID,
      providerCustomerId: "55ee219b-1a3f-4770-8b85-5ce022c1c0d1",
      receivedAmount: "16.31",
      deliveredAssetRail,
    });

    assert.deepEqual(completedSale("usdc_sol"), expected("usdc.solana"));
    assert.deepEqual(completedSale("eth"), expected(null));
  });

  it("reports no rail when the sale does not name its crypto", () => {
    const { baseCurrency: _omitted, ...withoutCrypto } = waitingForDepositPayload;
    const event = moonpaySellTransactionSettlementEvent(
      parseSell({ ...withoutCrypto, status: "completed" })
    );
    assert.equal("deliveredAssetRail" in event, false);
  });

  it("maps failed to failed with the failure reason", () => {
    const event = moonpaySellTransactionSettlementEvent(
      parseSell({ ...waitingForDepositPayload, status: "failed", failureReason: "Deposit timeout" })
    );
    assert.deepEqual(event, {
      provider: "moonpay",
      kind: "failed",
      reference: "cca8ef45-4aac-4a91-851a-02ff991eeef9",
      transferId: SDP_TRANSFER_ID,
      providerCustomerId: "55ee219b-1a3f-4770-8b85-5ce022c1c0d1",
      error: "Deposit timeout",
    });
  });

  it("ignores statuses MoonPay ships later instead of failing", () => {
    const event = moonpaySellTransactionSettlementEvent(
      parseSell({ ...waitingForDepositPayload, status: "somethingNew" })
    );
    assert.deepEqual(event, {
      provider: "moonpay",
      kind: "ignore",
      reason: "unsupported_status:somethingNew",
    });
  });

  it("ignores transactions without an SDP reference", () => {
    const event = moonpaySellTransactionSettlementEvent(
      parseSell({ ...waitingForDepositPayload, externalTransactionId: null })
    );
    assert.deepEqual(event, {
      provider: "moonpay",
      kind: "ignore",
      reason: "missing_external_transaction_id",
    });
  });
});
