import { describe, expect, it } from "vitest";
import {
  bvnkChannelTransactionEvent,
  bvnkCryptoStatusChangeEvent,
  bvnkPayinStatusChangeEvent,
  bvnkWalletStatusChangeEvent,
} from "@/test/helpers/bvnk";
import { BvnkWebhookProcessor } from "./bvnk";

describe("BvnkWebhookProcessor.parse", () => {
  it("parses a ledger wallet status-change webhook resolved by wallet id", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(bvnkWalletStatusChangeEvent({ id: "a:1:wallet:1", status: "ACTIVE" }))
    ).toMatchObject({
      event: "ledger:v2:wallet:status-change",
      data: {
        id: "a:1:wallet:1",
        status: "ACTIVE",
      },
    });
  });

  it("parses a BVNK wallet create webhook with data.id", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:ledger:wallet:create",
        data: {
          id: "a:1:wallet:created",
          status: "COMPLETED",
          paymentInstruments: [
            {
              type: "FIAT",
              accountNumber: "900368997705",
              bankDetails: { bic: "101019644", name: "BVNK Bank" },
            },
          ],
        },
      })
    ).toMatchObject({
      event: "bvnk:ledger:wallet:create",
      data: {
        id: "a:1:wallet:created",
        status: "COMPLETED",
      },
    });
  });

  it("parses a BVNK fiat pay-in status-change webhook, stringifying the amount", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkPayinStatusChangeEvent())).toEqual({
      event: "bvnk:payment:payin:status-change",
      data: {
        status: "COMPLETED",
        customerReference: "customer_1",
        beneficiary: { walletId: "a:1:wallet:1" },
        amount: { value: "100" },
        uuid: "payin_1",
      },
    });
  });

  it("parses a crypto status-change webhook carrying the direction and status", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkCryptoStatusChangeEvent())).toMatchObject({
      event: "bvnk:payment:crypto:status-change",
      data: {
        type: "OUT",
        status: "COMPLETED",
      },
    });
  });

  it("parses a channel transaction-detected webhook", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkChannelTransactionEvent("transaction-detected"))).toEqual({
      event: "bvnk:payment:channel:transaction-detected",
      data: { reference: "bvnk-sandbox-test-payment" },
    });
  });

  it("parses a channel transaction SDP did not create without throwing", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(
        bvnkChannelTransactionEvent("transaction-confirmed", {
          uuid: "tx_1",
          walletCurrency: "USD",
          walletAmount: 4.95,
        })
      )
    ).toEqual({
      event: "bvnk:payment:channel:transaction-confirmed",
      data: {
        reference: "bvnk-sandbox-test-payment",
        walletAmount: "4.95",
      },
    });
  });

  it("accepts an sdp_offramp reference and stringifies its walletAmount", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(
        bvnkChannelTransactionEvent("transaction-confirmed", {
          reference: "sdp_offramp_xfr_123e4567-e89b-12d3-a456-426614174000",
          walletAmount: 100,
        })
      )
    ).toEqual({
      event: "bvnk:payment:channel:transaction-confirmed",
      data: {
        reference: "sdp_offramp_xfr_123e4567-e89b-12d3-a456-426614174000",
        walletAmount: "100",
      },
    });
  });

  it("ignores an unhandled BVNK event instead of throwing", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:totally:new-event",
        data: {},
      })
    ).toEqual({ event: "ignore", reason: "unsupported_event:bvnk:totally:new-event" });
  });

  it("ignores an unhandled BVNK event without a data object", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse({ event: "bvnk:totally:new-event" })).toEqual({
      event: "ignore",
      reason: "unsupported_event:bvnk:totally:new-event",
    });
  });

  it("rejects a handled BVNK event missing its data object with a 400", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() => processor.parse({ event: "bvnk:payment:payin:status-change" })).toThrowError(
      'BVNK webhook "bvnk:payment:payin:status-change" is missing a data object'
    );
  });
});
