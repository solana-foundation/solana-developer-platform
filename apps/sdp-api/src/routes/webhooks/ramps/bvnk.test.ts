import { BVNK_CHANNEL_TRANSACTION_CONFIRMED_WEBHOOK } from "@sdp/payments/ramps/providers/bvnk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  BVNK_WEBHOOK_TIMESTAMP,
  bvnkAgreementSessionStatusChangeEvent,
  bvnkChannelTransactionEvent,
  bvnkPlatformCustomerUpdateEvent,
  bvnkV1PayinEvent,
} from "@/test/helpers/bvnk";
import { BvnkWebhookProcessor } from "./bvnk";

/** The parsed shape of the fixture's confirmed defaults: every money field as a decimal string. */
const CONFIRMED_FIXTURE_PARSED = {
  channelId: "channel_1",
  merchantId: "merchant_1",
  walletId: "a:1:wallet:1",
  merchantDisplayName: "sdp:onramp:counterparty_provider_account_1",
  reference: "bvnk-sandbox-test-payment",
  dateCreated: 1782627748000,
  lastUpdated: 1782627771174,
  status: "COMPLETE",
  uuid: "tx_1",
  hash: "hash_1",
  address: "address_1",
  tag: null,
  paidCurrency: "USDC",
  displayCurrency: "USD",
  walletCurrency: "USD",
  feeCurrency: "USD",
  paidAmount: "5",
  displayAmount: "4.95",
  walletAmount: "4.95",
  feeAmount: "0.04",
  exchangeRate: {
    base: "USDC",
    counter: "USD",
    rate: "0.99",
    baseAmount: "5",
    counterAmount: "4.95",
  },
  displayRate: {
    base: "USDC",
    counter: "USD",
    rate: "0.99",
    baseAmount: "5",
    counterAmount: "4.95",
  },
  risk: { level: "UNKNOWN", resourceName: "UNKNOWN", resourceCategory: "UNKNOWN", alerts: [] },
  sources: ["src_1", "src_2"],
  networkFee: {
    paidCurrency: "SOL",
    paidAmount: "0.00001",
    displayCurrency: "USD",
    displayAmount: "0",
  },
  pegged: false,
  metaData: null,
  originator: null,
  embeddedCustomerDetails: { reference: "customer_1" },
} as const;

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
          customer: { id: "00000000-0000-4000-8000-00000000c057", name: "Synthetic Customer" },
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
        customer: { id: "00000000-0000-4000-8000-00000000c057" },
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
      data: CONFIRMED_FIXTURE_PARSED,
    });
  });

  it("parses the observed confirmed channel-transaction payload in full", () => {
    const payload: unknown = BVNK_CHANNEL_TRANSACTION_CONFIRMED_WEBHOOK;
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(payload)).toEqual({
      event: "bvnk:payment:channel:transaction-confirmed",
      data: {
        channelId: "01000000-0000-7000-8000-00000000c002",
        merchantId: "00000000-0000-4000-8000-0000000000aa",
        walletId: "a:10000000000002:TESTWLT:1",
        merchantDisplayName:
          "sdp:onramp:counterparty_provider_account_00000000-0000-4000-8000-0000000000cf",
        reference: "sdp_offramp_xfr_00000000-0000-4000-8000-0000000000f2",
        dateCreated: 1790051985000,
        lastUpdated: 1790052118171,
        status: "COMPLETE",
        uuid: "01000000-0000-7000-8000-00000000c7a1",
        hash: "TestDepos1tS1gnature11111111111111111111111111111111111111111111111111111111111111111111",
        address: "TestChanne1Depos1tAddress111111111111111111",
        tag: null,
        paidCurrency: "USDC",
        displayCurrency: "USD",
        walletCurrency: "USD",
        feeCurrency: "USD",
        paidAmount: "10",
        displayAmount: "9.9",
        walletAmount: "9.9",
        feeAmount: "0.09",
        exchangeRate: {
          base: "USDC",
          counter: "USD",
          rate: "0.99",
          baseAmount: "10",
          counterAmount: "9.9",
        },
        displayRate: {
          base: "USDC",
          counter: "USD",
          rate: "0.99",
          baseAmount: "10",
          counterAmount: "9.9",
        },
        risk: {
          level: "UNKNOWN",
          resourceName: "UNKNOWN",
          resourceCategory: "UNKNOWN",
          alerts: [],
        },
        sources: [
          "TestSourceWa11etOne111111111111111111111111",
          "TestSourceWa11etTwo111111111111111111111111",
        ],
        networkFee: {
          paidCurrency: "SOL",
          paidAmount: "0.00001",
          displayCurrency: "USD",
          displayAmount: "0",
        },
        pegged: false,
        metaData: null,
        originator: null,
        embeddedCustomerDetails: { reference: "00000000-0000-4000-8000-00000000c058" },
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
