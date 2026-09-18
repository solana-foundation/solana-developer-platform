import { buildBvnkFundingWalletName } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { describe, expect, it } from "vitest";
import {
  BVNK_WEBHOOK_TIMESTAMP,
  bvnkAgreementSessionStatusChangeEvent,
  bvnkChannelTransactionEvent,
  bvnkCryptoPayoutStatusChangeEvent,
  bvnkPayinStatusChangeEvent,
  bvnkPlatformCustomerStatusChangeEvent,
  bvnkPlatformCustomerUpdateEvent,
  bvnkWalletStatusChangeEvent,
} from "@/test/helpers/bvnk";
import { BvnkWebhookProcessor } from "./bvnk";

describe("BvnkWebhookProcessor.parse", () => {
  it("parses a platform customer status-change webhook", () => {
    const processor = new BvnkWebhookProcessor();
    const event = bvnkPlatformCustomerStatusChangeEvent();

    expect(processor.parse(event)).toEqual(event);
  });

  it("rejects a platform customer status-change whose status is not the uppercase enum", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() =>
      processor.parse({
        event: "bvnk:platform:customer:status-change",
        eventId: "01a0b1ec-bc16-76e8-a168-d44c4d7d25ad",
        timestamp: BVNK_WEBHOOK_TIMESTAMP,
        data: { status: "verified", reference: "customer_1" },
      })
    ).toThrow(/failed validation/);
  });

  it("no longer recognises the v1 customers:status-change event name", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:customers:status-change",
        data: { customerId: "customer_1", status: "VERIFIED" },
      })
    ).toEqual({ event: "ignore", reason: "unsupported_event:bvnk:customers:status-change" });
  });

  it("parses a platform customer update webhook", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkPlatformCustomerUpdateEvent())).toEqual({
      event: "bvnk:platform:customer:update",
      data: { reference: "123e4567-e89b-12d3-a456-426614174000" },
    });
  });

  it("parses an agreement-session status-change webhook", () => {
    const processor = new BvnkWebhookProcessor();
    const event = bvnkAgreementSessionStatusChangeEvent();

    expect(processor.parse(event)).toEqual(event);
  });

  it("parses a ledger wallet status-change webhook", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(
        bvnkWalletStatusChangeEvent({
          name: "sdp:onramp:cpty_123:USD:USDC_SOLANA:dest",
        })
      )
    ).toEqual({
      event: "ledger:v2:wallet:status-change",
      data: {
        id: "a:synthetic:wallet:1",
        name: "sdp:onramp:cpty_123:USD:USDC_SOLANA:dest",
        status: "ACTIVE",
        customer: { id: "customer_1" },
        bankAccount: { accountNumber: "900473221558", code: "LEADUS49XXX", bankName: "LEAD BANK" },
      },
    });
  });

  it("parses a funding wallet status-change webhook", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(
        bvnkWalletStatusChangeEvent({
          name: buildBvnkFundingWalletName("cpa_123"),
        })
      )
    ).toEqual({
      event: "ledger:v2:wallet:status-change",
      data: {
        id: "a:synthetic:wallet:1",
        name: "sdp:onramp:cpa_123",
        status: "ACTIVE",
        customer: { id: "customer_1" },
        bankAccount: { accountNumber: "900473221558", code: "LEADUS49XXX", bankName: "LEAD BANK" },
      },
    });
  });

  it("parses the observed wallet status-change shape and strips customer PII", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "ledger:v2:wallet:status-change",
        eventId: "evt_synthetic_1",
        timestamp: "2026-09-18T01:08:21.014395318Z",
        data: {
          id: "a:synthetic:wallet:1",
          name: "sdp:onramp:counterparty_provider_account_402478d1-2f23-4559-b3e1-58a0f693de9b",
          status: "ACTIVE",
          balance: { amount: 0, currency: "USD" },
          customer: { id: "2acdd3e5-7166-4b04-8115-6ad3ccd66477", name: "Synthetic Customer" },
          createdAt: "2026-09-18T00:00:00.000Z",
          updatedAt: "2026-09-18T01:00:00.000Z",
          paymentInstruments: [
            {
              type: "FIAT",
              bankDetails: { bic: "LEADUS49XXX", name: "LEAD BANK" },
              accountNumber: "900473221558",
              accountHolderName: "Synthetic Holder",
            },
          ],
        },
      })
    ).toEqual({
      event: "ledger:v2:wallet:status-change",
      data: {
        id: "a:synthetic:wallet:1",
        name: "sdp:onramp:counterparty_provider_account_402478d1-2f23-4559-b3e1-58a0f693de9b",
        status: "ACTIVE",
        customer: { id: "2acdd3e5-7166-4b04-8115-6ad3ccd66477" },
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
          walletName: "sdp:onramp:cpty_123:USD:USDC_SOLANA:dest",
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

  it("parses a BVNK fiat pay-in status-change webhook under the v2 event name", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkPayinStatusChangeEvent())).toEqual({
      event: "payment:v2:payin:status-change",
      data: {
        id: "payin_1",
        status: "COMPLETED",
        beneficiary: {
          amount: "100",
          currency: "USD",
          walletId: "a:1:wallet:1",
          customerId: "customer_1",
        },
      },
    });
  });

  it("acknowledges the legacy bvnk:payment:payin:status-change name as unsupported", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:payment:payin:status-change",
        data: { status: "COMPLETED", customerReference: "customer_1" },
      })
    ).toEqual({
      event: "ignore",
      reason: "unsupported_event:bvnk:payment:payin:status-change",
    });
  });

  it("parses a pay-in whose status is not in the acted-on vocabulary as a plain string", () => {
    const processor = new BvnkWebhookProcessor();

    const parsed = processor.parse(
      bvnkPayinStatusChangeEvent({ id: "payin_unknown_status", status: "REFUNDED" })
    );

    expect(parsed).toEqual({
      event: "payment:v2:payin:status-change",
      data: {
        id: "payin_unknown_status",
        status: "REFUNDED",
        beneficiary: {
          amount: "100",
          currency: "USD",
          walletId: "a:1:wallet:1",
          customerId: "customer_1",
        },
      },
    });
  });

  it("parses the observed crypto payout shape and strips PII and extra keys", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:payment:crypto:status-change",
        eventId: "evt_crypto_payout",
        timestamp: "2026-09-18T01:08:21.014395318Z",
        data: {
          type: "OUT",
          uuid: "payout_1",
          status: "COMPLETE",
          walletId: "a:1:wallet:1",
          reference: "ON_RAMP_payin_1",
          address: { address: "dest", network: "SOLANA", protocol: "SOL" },
          paidCurrency: { actual: 9.8802, amount: 9.8802, currency: "USDC" },
          walletCurrency: { actual: 9.9, amount: 9.9, currency: "USD" },
          feeCurrency: { actual: 0.1, amount: 0.1, currency: "USD" },
          exchangeRate: { base: "USD", rate: 0.998, counter: "USDC" },
          transactions: [{ hash: "tx_synthetic_1", amount: 9.8802, fee: 0 }],
          redirectUrl: "https://pay.sandbox.bvnk.com/payout/payout_1",
          originator: { name: "Synthetic Buyer", accountNumber: "900473221558" },
        },
      })
    ).toEqual({
      event: "bvnk:payment:crypto:status-change",
      data: {
        type: "OUT",
        uuid: "payout_1",
        status: "COMPLETE",
        walletId: "a:1:wallet:1",
        reference: "ON_RAMP_payin_1",
        address: { address: "dest", network: "SOLANA" },
        paidCurrency: { actual: "9.8802", amount: "9.8802", currency: "USDC" },
        walletCurrency: { actual: "9.9", amount: "9.9", currency: "USD" },
        feeCurrency: { actual: "0.1", amount: "0.1", currency: "USD" },
        exchangeRate: { base: "USD", rate: 0.998, counter: "USDC" },
        transactions: [{ hash: "tx_synthetic_1" }],
      },
    });
  });

  it("parses a crypto payout whose status is not in the acted-on vocabulary as a plain string", () => {
    const processor = new BvnkWebhookProcessor();

    const parsed = processor.parse(bvnkCryptoPayoutStatusChangeEvent({ status: "CANCELLED" }));

    expect(parsed).toEqual({
      event: "bvnk:payment:crypto:status-change",
      data: {
        type: "OUT",
        uuid: "payout_1",
        status: "CANCELLED",
        walletId: "a:1:wallet:1",
        reference: "ON_RAMP_payin_1",
        address: { address: "dest", network: "SOLANA" },
        paidCurrency: { actual: "0", amount: "9.8802", currency: "USDC" },
        walletCurrency: { actual: "0", amount: "9.9", currency: "USD" },
        feeCurrency: { actual: "0", amount: "0.1", currency: "USD" },
        exchangeRate: { base: "USD", rate: 0.998, counter: "USDC" },
        transactions: [],
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

    expect(() => processor.parse({ event: "bvnk:platform:customer:status-change" })).toThrowError(
      'BVNK webhook "bvnk:platform:customer:status-change" is missing a data object'
    );
  });
});
