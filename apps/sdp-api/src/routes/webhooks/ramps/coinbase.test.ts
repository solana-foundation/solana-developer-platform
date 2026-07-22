import { describe, expect, it } from "vitest";
import { CoinbaseWebhookProcessor } from "./coinbase";

const processor = new CoinbaseWebhookProcessor();

/** Real sandbox delivery captured 2026-07-21 via ngrok; success events add txHash. */
function sandboxOrderEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    createdAt: "2026-07-21T10:40:23.439Z",
    destinationAddress: "sWzzJyQjbqh5bmPcHdmGEnggfrkGmqWxE43GPjZ9GFD",
    destinationNetwork: "solana",
    exchangeRate: "1",
    fees: [
      { feeAmount: "0", feeCurrency: "USD", feeType: "FEE_TYPE_NETWORK" },
      { feeAmount: "0.05", feeCurrency: "USD", feeType: "FEE_TYPE_EXCHANGE" },
    ],
    orderId: "1f184f09-3d65-690d-b3b1-ba4a77af2429",
    partnerUserRef: "sandbox-counterparty_c8e2e54c-60b6-4f4b-8d50-1f76cb64b2a8",
    paymentCurrency: "USD",
    paymentMethod: "GUEST_CHECKOUT_APPLE_PAY",
    paymentSubtotal: "2",
    paymentTotal: "2.05",
    purchaseAmount: "2",
    purchaseCurrency: "USDC",
    updatedAt: "2026-07-21T10:40:28.704Z",
    ...overrides,
  };
}

describe("CoinbaseWebhookProcessor.parse", () => {
  it("maps a created order awaiting payment to awaiting_payment", () => {
    expect(
      processor.parse(
        sandboxOrderEvent({
          eventType: "onramp.transaction.created",
          status: "ONRAMP_ORDER_STATUS_PENDING_PAYMENT",
        })
      )
    ).toEqual({
      provider: "coinbase",
      kind: "awaiting_payment",
      reference: "1f184f09-3d65-690d-b3b1-ba4a77af2429",
    });
  });

  it("maps a processing update to settling", () => {
    expect(
      processor.parse(
        sandboxOrderEvent({
          eventType: "onramp.transaction.updated",
          status: "ONRAMP_ORDER_STATUS_PROCESSING",
        })
      )
    ).toEqual({
      provider: "coinbase",
      kind: "settling",
      reference: "1f184f09-3d65-690d-b3b1-ba4a77af2429",
    });
  });

  it("maps a success event to settled with delivered amount and economics", () => {
    expect(
      processor.parse(
        sandboxOrderEvent({
          eventType: "onramp.transaction.success",
          status: "ONRAMP_ORDER_STATUS_COMPLETED",
          txHash: "sandbox_tx_hash",
        })
      )
    ).toEqual({
      provider: "coinbase",
      kind: "settled",
      reference: "1f184f09-3d65-690d-b3b1-ba4a77af2429",
      receivedAmount: "2",
      settlement: {
        provider: "coinbase",
        status: "completed",
        paymentCurrency: "USD",
        paymentSubtotal: "2",
        paymentTotal: "2.05",
        purchaseCurrency: "USDC",
        purchaseAmount: "2",
        exchangeRate: "1",
        fees: [
          { feeAmount: "0", feeCurrency: "USD", feeType: "FEE_TYPE_NETWORK" },
          { feeAmount: "0.05", feeCurrency: "USD", feeType: "FEE_TYPE_EXCHANGE" },
        ],
        txHash: "sandbox_tx_hash",
      },
    });
  });

  it("maps a failed event to failed with the failure reason", () => {
    expect(
      processor.parse(
        sandboxOrderEvent({
          eventType: "onramp.transaction.failed",
          status: "ONRAMP_ORDER_STATUS_FAILED",
          failureReason: "card_declined",
        })
      )
    ).toMatchObject({
      provider: "coinbase",
      kind: "failed",
      reference: "1f184f09-3d65-690d-b3b1-ba4a77af2429",
      error: "card_declined",
      settlement: { provider: "coinbase", status: "failed", failureReason: "card_declined" },
    });
  });

  it("ignores event types outside the onramp order lifecycle", () => {
    expect(
      processor.parse(sandboxOrderEvent({ eventType: "offramp.transaction.created" }))
    ).toEqual({
      provider: "coinbase",
      kind: "ignore",
      reason: "unsupported_event:offramp.transaction.created",
    });
  });

  it("ignores lifecycle events with an unrecognized status", () => {
    expect(
      processor.parse(
        sandboxOrderEvent({
          eventType: "onramp.transaction.updated",
          status: "ONRAMP_ORDER_STATUS_SOMETHING_NEW",
        })
      )
    ).toEqual({
      provider: "coinbase",
      kind: "ignore",
      reason: "unhandled:onramp.transaction.updated:ONRAMP_ORDER_STATUS_SOMETHING_NEW",
    });
  });

  it("throws on payloads violating the event envelope", () => {
    expect(() =>
      processor.parse(
        sandboxOrderEvent({ eventType: "onramp.transaction.created", orderId: undefined })
      )
    ).toThrow("Coinbase webhook payload violates the onramp event envelope");
    expect(() => processor.parse(sandboxOrderEvent({}))).toThrow(
      "Coinbase webhook payload violates the onramp event envelope"
    );
    expect(() => processor.parse("not an object")).toThrow(
      "Coinbase webhook payload violates the onramp event envelope"
    );
  });
});
