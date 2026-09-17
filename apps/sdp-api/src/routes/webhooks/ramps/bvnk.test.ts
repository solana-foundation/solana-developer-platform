import { buildBvnkOnrampWalletName } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { describe, expect, it } from "vitest";
import {
  bvnkAgreementStatusChangeEvent,
  bvnkChannelTransactionEvent,
  bvnkCustomerStatusChangeEvent,
  bvnkPayinStatusChangeEvent,
  bvnkPlatformCustomerUpdateEvent,
  bvnkWalletStatusChangeEvent,
} from "@/test/helpers/bvnk";
import { BvnkWebhookProcessor } from "./bvnk";

const ONRAMP_KEY = "USD:USDC_SOLANA:dest";

describe("BvnkWebhookProcessor.parse", () => {
  it("parses a customer status-change webhook", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkCustomerStatusChangeEvent())).toEqual({
      event: "bvnk:customers:status-change",
      data: {
        customerId: "customer_1",
        status: "VERIFIED",
      },
    });
  });

  it("rejects a customer status-change whose status is not the uppercase enum", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() =>
      processor.parse({
        event: "bvnk:customers:status-change",
        data: { customerId: "customer_1", status: "verified" },
      })
    ).toThrow(/failed validation/);
  });

  it("parses a platform customer update webhook", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkPlatformCustomerUpdateEvent())).toEqual({
      event: "bvnk:platform:customer:update",
      data: { reference: "cp_123e4567e89b12d3a456426614174000" },
    });
  });

  it("parses an agreement status-change webhook", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(
        bvnkAgreementStatusChangeEvent({
          status: "ACCEPTED",
          respondedAt: "2026-09-02T00:00:00.000Z",
        })
      )
    ).toEqual({
      event: "bvnk:customers:agreements:status-change",
      data: {
        customerId: "customer_1",
        agreementId: "agreement_1",
        status: "ACCEPTED",
        respondedAt: "2026-09-02T00:00:00.000Z",
      },
    });
  });

  it.each(["customerId", "agreementId"])("rejects an agreement event missing %s", (field) => {
    const processor = new BvnkWebhookProcessor();
    const data = bvnkAgreementStatusChangeEvent().data;
    delete data[field as keyof typeof data];

    expect(() =>
      processor.parse({ event: "bvnk:customers:agreements:status-change", data })
    ).toThrow(/failed validation/);
  });

  it("parses a ledger wallet status-change webhook", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(
        bvnkWalletStatusChangeEvent({
          name: buildBvnkOnrampWalletName("cpty_123", ONRAMP_KEY),
        })
      )
    ).toEqual({
      event: "ledger:v2:wallet:status-change",
      data: {
        name: "sdp:onramp:cpty_123:USD:USDC_SOLANA:dest",
        status: "ACTIVE",
        bankAccount: { accountNumber: "900473221558", code: "LEADUS49XXX", bankName: "LEAD BANK" },
      },
    });
  });

  it("parses BVNK wallet create webhooks with walletName", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:ledger:wallet:create",
        data: {
          walletName: buildBvnkOnrampWalletName("cpty_123", ONRAMP_KEY),
          status: "COMPLETED",
          ledgers: [{ accountNumber: "900368997705", code: "101019644" }],
        },
      })
    ).toEqual({
      event: "bvnk:ledger:wallet:create",
      data: {
        name: "sdp:onramp:cpty_123:USD:USDC_SOLANA:dest",
        status: "COMPLETED",
        bankAccount: { accountNumber: "900368997705", code: "101019644" },
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

    expect(() => processor.parse({ event: "bvnk:customers:status-change" })).toThrowError(
      'BVNK webhook "bvnk:customers:status-change" is missing a data object'
    );
  });
});
