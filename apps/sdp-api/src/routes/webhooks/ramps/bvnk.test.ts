import { describe, expect, it } from "vitest";
import { buildBvnkOnrampWalletName } from "@/lib/ramps/providers/bvnk/provider-data";
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
          walletName: buildBvnkOnrampWalletName("counterparty_123", ONRAMP_KEY),
          customerReference: "customer_1",
          ledgers: [{ type: "FIAT", accountNumber: "900368997705", code: "101019644" }],
        },
      })
    ).toMatchObject({
      kind: "bvnk:ledger:wallet:create",
      customerReference: "customer_1",
      walletId: "wallet_1",
      walletName: "sdp:onramp:counterparty_123:USD:USDC_SOLANA:dest",
      walletStatus: "COMPLETED",
      bankAccount: { accountNumber: "900368997705" },
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

  it("ignores an unhandled BVNK event instead of throwing", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:totally:new-event",
        data: {},
      })
    ).toEqual({ kind: "ignore", event: "bvnk:totally:new-event" });
  });
});
