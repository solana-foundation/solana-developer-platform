import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
      data: CONFIRMED_FIXTURE_PARSED,
    });
  });

  it("accepts an sdp_offramp reference and stringifies its walletAmount", () => {
    const processor = new BvnkWebhookProcessor();
    const reference = "sdp_offramp_xfr_123e4567-e89b-12d3-a456-426614174000";

    expect(
      processor.parse(bvnkChannelTransactionEvent("transaction-confirmed", { reference }))
    ).toEqual({
      event: "bvnk:payment:channel:transaction-confirmed",
      data: {
        ...CONFIRMED_FIXTURE_PARSED,
        reference,
        walletAmount: "100",
      },
    });
  });

  it("parses the observed confirmed channel-transaction payload in full", () => {
    const payloadUrl = new URL(
      "../../../../../../docs/_devlog/HOO-1710/payloads/channel-transaction-confirmed.json",
      import.meta.url
    );
    const payload = JSON.parse(readFileSync(fileURLToPath(payloadUrl), "utf8")) as unknown;
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(payload)).toEqual({
      event: "bvnk:payment:channel:transaction-confirmed",
      data: {
        channelId: "01a0c769-44c1-7064-bea7-522a4c5def00",
        merchantId: "f40021ec-a48f-4186-b9c5-1abc71f4f4a8",
        walletId: "a:26091854404227:N4fqg2A:1",
        merchantDisplayName:
          "sdp:onramp:counterparty_provider_account_2bd4aeca-01d6-4dbb-8471-ff312c6ecd30",
        reference: "sdp_offramp_xfr_6a78d488-5c32-490d-b620-a70d7784c544",
        dateCreated: 1790051985000,
        lastUpdated: 1790052118171,
        status: "COMPLETE",
        uuid: "01a0c769-a709-7520-803d-675b49a739f5",
        hash: "4ep657PdRL8MFuoSrMwSXXqHYycnacQc1JMYSxz9Lan6Yuep7VSLsfB2zfGZcDpAoxNV2Si3u7i3nuScjAUrfDn6",
        address: "A8sPnzHUS9hEMkKt8Dia3Sy3t95xFMPving6XCFdf5AM",
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
          "ETdP97bEd8k2pQbtLLZTSwg1XbZqwFVHd17aBDMyziVw",
          "6Lwr3tNtTxGfViCqVSzeZpS2ZJxaY9WnUGQDgnDW3Lvs",
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
        embeddedCustomerDetails: { reference: "b84c506f-3172-4a0a-adad-c399619090d0" },
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
