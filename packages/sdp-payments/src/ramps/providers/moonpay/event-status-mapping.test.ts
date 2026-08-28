import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  moonpaySellTransactionSchema,
  moonpaySellTransactionSettlementEvent,
} from "./event-status-mapping";

// Trimmed from a real sandbox `sell_transaction_created` webhook (2026-08-28).
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
  externalTransactionId: "ramp_quote_c79c556a-0e06-4d77-9b50-6e2e765099ac",
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
      reference: "ramp_quote_c79c556a-0e06-4d77-9b50-6e2e765099ac",
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
      reference: "ramp_quote_c79c556a-0e06-4d77-9b50-6e2e765099ac",
      providerCustomerId: "55ee219b-1a3f-4770-8b85-5ce022c1c0d1",
      cryptoDeposit: null,
    });
  });

  it("maps completed to settled with the fiat received amount", () => {
    const event = moonpaySellTransactionSettlementEvent(
      parseSell({ ...waitingForDepositPayload, status: "completed" })
    );
    assert.deepEqual(event, {
      provider: "moonpay",
      kind: "settled",
      reference: "ramp_quote_c79c556a-0e06-4d77-9b50-6e2e765099ac",
      providerCustomerId: "55ee219b-1a3f-4770-8b85-5ce022c1c0d1",
      receivedAmount: "16.31",
    });
  });

  it("maps failed to failed with the failure reason", () => {
    const event = moonpaySellTransactionSettlementEvent(
      parseSell({ ...waitingForDepositPayload, status: "failed", failureReason: "Deposit timeout" })
    );
    assert.deepEqual(event, {
      provider: "moonpay",
      kind: "failed",
      reference: "ramp_quote_c79c556a-0e06-4d77-9b50-6e2e765099ac",
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
