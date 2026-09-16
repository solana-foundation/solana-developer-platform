import {
  buildBvnkOfframpWalletName,
  buildBvnkOnrampWalletName,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { describe, expect, it } from "vitest";
import { BvnkWebhookProcessor } from "./bvnk";

const ONRAMP_KEY = "USD:USDC_SOLANA:dest";

describe("BvnkWebhookProcessor.parse", () => {
  it("parses BVNK wallet create webhooks with walletName", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:ledger:wallet:create",
        data: {
          id: "wallet_1",
          status: "COMPLETED",
          walletName: buildBvnkOnrampWalletName("cpty_123", ONRAMP_KEY),
          customerReference: "customer_1",
          ledgers: [{ type: "FIAT", accountNumber: "900368997705", code: "101019644" }],
        },
      })
    ).toMatchObject({
      kind: "bvnk:wallet:onramp",
      event: "bvnk:ledger:wallet:create",
      wallet: { direction: "onramp", counterpartyId: "cpty_123", onrampKey: ONRAMP_KEY },
      walletStatus: "COMPLETED",
      bankAccount: { accountNumber: "900368997705" },
    });
  });

  it("ignores a wallet status-change webhook without a wallet name", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "ledger:v2:wallet:status-change",
        data: { id: "wallet_1", status: "ACTIVE" },
      })
    ).toEqual({ kind: "ignore", event: "ledger:v2:wallet:status-change" });
  });

  it("ignores a wallet create webhook without a walletName", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:ledger:wallet:create",
        data: { id: "wallet_1", status: "ACTIVE" },
      })
    ).toEqual({ kind: "ignore", event: "bvnk:ledger:wallet:create" });
  });

  it("ignores a wallet event for a wallet name SDP did not create", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "ledger:v2:wallet:status-change",
        data: { id: "wallet_1", name: "merchant-wallet-1", status: "ACTIVE" },
      })
    ).toEqual({ kind: "ignore", event: "ledger:v2:wallet:status-change" });
  });

  it("parses an sdp:onramp wallet name into the onramp wallet arm", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "ledger:v2:wallet:status-change",
        data: {
          id: "wallet_1",
          name: buildBvnkOnrampWalletName("cpty_123", ONRAMP_KEY),
          status: "ACTIVE",
        },
      })
    ).toMatchObject({
      kind: "bvnk:wallet:onramp",
      event: "ledger:v2:wallet:status-change",
      wallet: { direction: "onramp", counterpartyId: "cpty_123", onrampKey: ONRAMP_KEY },
    });
  });

  it("parses an sdp:offramp wallet name into the offramp wallet arm", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:ledger:wallet:create",
        data: { walletName: buildBvnkOfframpWalletName("USD", "cpty_123"), status: "ACTIVE" },
      })
    ).toMatchObject({
      kind: "bvnk:wallet:offramp",
      event: "bvnk:ledger:wallet:create",
      wallet: { direction: "offramp", counterpartyId: "cpty_123", fiatCurrency: "USD" },
      walletStatus: "ACTIVE",
    });
  });

  it("parses a BVNK fiat pay-in status-change webhook", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:payment:payin:status-change",
        data: {
          status: "COMPLETED",
          customerReference: "customer_1",
          amount: { value: 100, currencyCode: "USD" },
          beneficiary: { walletId: "a:1:wallet:1" },
        },
      })
    ).toMatchObject({
      kind: "bvnk:payment:payin:status-change",
      customerReference: "customer_1",
      walletId: "a:1:wallet:1",
      status: "COMPLETED",
      amount: "100",
    });
  });

  it("parses a customers:status-change webhook with the native reference and status", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:customers:status-change",
        data: {
          customerId: "6e366883-18e1-4ed6-a531-4eacd8b85fc2",
          status: "VERIFIED",
          customerType: "INDIVIDUAL",
          requiredActions: [],
        },
      })
    ).toEqual({
      kind: "bvnk:customers:status-change",
      customerReference: "6e366883-18e1-4ed6-a531-4eacd8b85fc2",
      customerStatus: "VERIFIED",
    });
  });

  it("rejects a customers:status-change webhook missing status", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() =>
      processor.parse({
        event: "bvnk:customers:status-change",
        data: { customerId: "6e366883-18e1-4ed6-a531-4eacd8b85fc2" },
      })
    ).toThrow(/status: Invalid input/);
  });

  it("parses a platform:customer:status-change webhook with the native reference and status", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:platform:customer:status-change",
        eventId: "01a0aae6-6e99-7e70-adc1-a01910944daa",
        data: { status: "VERIFIED", reference: "3881b60e-50ae-40ac-8110-d413ca1b0dda" },
      })
    ).toEqual({
      kind: "bvnk:platform:customer:status-change",
      customerReference: "3881b60e-50ae-40ac-8110-d413ca1b0dda",
      customerStatus: "VERIFIED",
    });
  });

  it("rejects a platform:customer:status-change webhook missing reference", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() =>
      processor.parse({
        event: "bvnk:platform:customer:status-change",
        data: { status: "VERIFIED" },
      })
    ).toThrow(/reference: Invalid input/);
  });

  it("parses a platform:customer:update webhook with the native reference, externalReference, and status", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:platform:customer:update",
        data: {
          reference: "6e366883-18e1-4ed6-a531-4eacd8b85fc2",
          status: "PENDING",
          externalReference: "edecd24a-78b8-4c21-8c3d-87b6e6156d3e",
        },
      })
    ).toEqual({
      kind: "bvnk:platform:customer:update",
      customerReference: "6e366883-18e1-4ed6-a531-4eacd8b85fc2",
      externalReference: "edecd24a-78b8-4c21-8c3d-87b6e6156d3e",
      customerStatus: "PENDING",
    });
  });

  it("rejects a platform:customer:update webhook missing the externalReference", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() =>
      processor.parse({
        event: "bvnk:platform:customer:update",
        data: { reference: "6e366883-18e1-4ed6-a531-4eacd8b85fc2", status: "PENDING" },
      })
    ).toThrow(/externalReference: Invalid input/);
  });

  it("rejects a platform:customer:update webhook missing status", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() =>
      processor.parse({
        event: "bvnk:platform:customer:update",
        data: {
          reference: "6e366883-18e1-4ed6-a531-4eacd8b85fc2",
          externalReference: "edecd24a-78b8-4c21-8c3d-87b6e6156d3e",
        },
      })
    ).toThrow(/status: Invalid input/);
  });

  it("acks an agreement status-change webhook as ignored", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:customers:agreements:status-change",
        data: {
          customerId: "customer_1",
          agreementId: "agreement_1",
          status: "ACCEPTED",
          respondedAt: "2026-09-02T00:00:00.000Z",
        },
      })
    ).toEqual({ kind: "ignore", event: "bvnk:customers:agreements:status-change" });
  });

  it("acks an agreement status-change webhook without a data object", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse({ event: "bvnk:customers:agreements:status-change" })).toEqual({
      kind: "ignore",
      event: "bvnk:customers:agreements:status-change",
    });
  });

  it("parses a channel transaction SDP did not create without throwing", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:payment:channel:transaction-confirmed",
        data: {
          reference: "bvnk-sandbox-test-payment",
          channelId: "channel_1",
          uuid: "tx_1",
          hash: "3B9neiFe2HG3P8ovttfH1XrppubeFtMcKWZDhw9rzLUqUSQrfLYdzpC3v3ctsbtQBt1rwUPkBaa4SWG2SZzqtXD2",
          status: "completed",
          paidCurrency: "USDC",
          displayCurrency: "USD",
          walletCurrency: "USD",
          walletAmount: 4.95,
        },
      })
    ).toMatchObject({
      kind: "bvnk:payment:channel:transaction-confirmed",
      transferId: undefined,
      channelId: "channel_1",
    });
  });

  it("rejects a channel transaction whose amount is not a positive decimal", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() =>
      processor.parse({
        event: "bvnk:payment:channel:transaction-confirmed",
        data: {
          reference: "sdp_offramp_xfr_00000000-0000-0000-0000-000000000000",
          walletAmount: "-10",
        },
      })
    ).toThrow(/walletAmount: Expected a positive decimal amount/);
  });

  it("extracts the SDP transfer id from an sdp_offramp reference", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:payment:channel:transaction-confirmed",
        data: {
          reference: "sdp_offramp_xfr_123e4567-e89b-12d3-a456-426614174000",
          channelId: "channel_1",
          uuid: "tx_1",
          hash: "3B9neiFe2HG3P8ovttfH1XrppubeFtMcKWZDhw9rzLUqUSQrfLYdzpC3v3ctsbtQBt1rwUPkBaa4SWG2SZzqtXD2",
          status: "completed",
          paidCurrency: "USDC",
          displayCurrency: "USD",
          walletCurrency: "USD",
        },
      })
    ).toMatchObject({
      kind: "bvnk:payment:channel:transaction-confirmed",
      transferId: "xfr_123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("ignores an unhandled BVNK event instead of throwing", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:totally:new-event",
        data: {},
      })
    ).toEqual({ kind: "ignore", event: "bvnk:totally:new-event" });
  });

  it("rejects a webhook missing the event with a 400", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() => processor.parse({ data: {} })).toThrowError("BVNK webhook is missing an event");
  });

  it("ignores an unhandled BVNK event without a data object", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse({ event: "bvnk:totally:new-event" })).toEqual({
      kind: "ignore",
      event: "bvnk:totally:new-event",
    });
  });

  it("rejects a handled BVNK event missing its data object with a 400", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() => processor.parse({ event: "bvnk:customers:status-change" })).toThrowError(
      'BVNK webhook "bvnk:customers:status-change" is missing a data object'
    );
  });
});
