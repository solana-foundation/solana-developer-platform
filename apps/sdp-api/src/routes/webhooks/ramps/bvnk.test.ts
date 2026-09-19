import { describe, expect, it } from "vitest";
import {
  BVNK_WEBHOOK_TIMESTAMP,
  bvnkAgreementSessionStatusChangeEvent,
  bvnkChannelTransactionEvent,
  bvnkPlatformCustomerUpdateEvent,
  bvnkV1PayinEvent,
} from "@/test/helpers/bvnk";
import { BvnkWebhookProcessor } from "./bvnk";

describe("BvnkWebhookProcessor.parse", () => {
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

  it("parses the v1 fiat pay-in status-change webhook and stringifies its amount", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkV1PayinEvent())).toEqual({
      event: "bvnk:payment:payin:status-change",
      eventId: "evt_payin_1",
      timestamp: BVNK_WEBHOOK_TIMESTAMP,
      data: {
        amount: { value: "100", currencyCode: "USD" },
        status: "COMPLETED",
        beneficiary: { walletId: "a:1:wallet:1" },
        paymentReference: "SDP-ONRAMP xfr_1",
        customerReference: "customer_1",
        transactionReference: "payin_1",
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
          reference: "xfr_123e4567-e89b-12d3-a456-426614174000",
          address: { address: "dest", network: "SOLANA", protocol: "SOL" },
          paidCurrency: { actual: 9.8802, amount: 9.8802, currency: "USDC" },
          walletCurrency: { actual: 9.9, amount: 9.9, currency: "USD" },
          feeCurrency: { actual: 0.1, amount: 0.1, currency: "USD" },
          networkFeeCurrency: { actual: 0, amount: 0, currency: "USD" },
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
        reference: "xfr_123e4567-e89b-12d3-a456-426614174000",
        address: { address: "dest", network: "SOLANA" },
        paidCurrency: { actual: "9.8802", amount: "9.8802", currency: "USDC" },
        walletCurrency: { actual: "9.9", amount: "9.9", currency: "USD" },
        feeCurrency: { actual: "0.1", amount: "0.1", currency: "USD" },
        networkFeeCurrency: { actual: "0", amount: "0", currency: "USD" },
        exchangeRate: { base: "USD", rate: 0.998, counter: "USDC" },
        transactions: [{ hash: "tx_synthetic_1" }],
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
