import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { LightsparkWebhookProcessor } from "./lightspark";
import type { AppContext } from "./processor";

const ORGANIZATION_ID = "org_lightspark_webhook_test";
const PROJECT_ID = "prj_lightspark_webhook_test";
const USER_ID = "usr_lightspark_webhook_test";
const TRANSFER_ID = "xfr_lightspark_webhook_test";
const QUOTE_ID = "Quote:01a05d36-ffdf-5246-0000-c60c0f1a2e75";
const DESTINATION_ADDRESS = "DestinationSolanaWallet111111111111111111111111";

const REAL_COMPLETED_PAYLOAD = `{
    "data": {
        "id": "Transaction:01a05d36-ffed-b78f-0000-04e720ad5690",
        "status": "COMPLETED",
        "type": "OUTGOING",
        "direction": "DEBIT",
        "destination": {
            "destinationType": "ACCOUNT",
            "accountId": "ExternalAccount:01a05d36-893e-6abf-0000-82c9c70d38b4",
            "onChainTransaction": {
                "transactionHash": "43T5oN1GC2xH4LkpsxwtFE7HqWBRjcejKYGbAgaDLJUZriCWTis8NBDG8D2WQBpXYpbXgvYP6d7syisQRxBVwdDH",
                "network": "SOLANA"
            }
        },
        "customerId": "Customer:01a05d36-8279-938e-0000-d5b3cdf7c5fa",
        "platformCustomerId": "cpty_a7a0c50c-2834-4ba0-8bac-f800923e4d66",
        "settledAt": "2026-09-01T13:46:18.026988Z",
        "createdAt": "2026-09-01T13:44:40.685136Z",
        "updatedAt": "2026-09-01T13:46:16.974560Z",
        "description": "SDP onramp",
        "sentAmount": { "amount": 1000, "currency": { "code": "USD", "name": "US Dollar", "symbol": "$", "decimals": 2 } },
        "exchangeRate": 0.0001,
        "quoteId": "Quote:01a05d36-ffdf-5246-0000-c60c0f1a2e75",
        "source": { "sourceType": "REALTIME_FUNDING", "currency": "USD", "customerId": "Customer:01a05d36-8279-938e-0000-d5b3cdf7c5fa" },
        "receivedAmount": { "amount": 10000000, "currency": { "code": "USDC", "name": "USD Coin", "symbol": "usdc", "decimals": 6 } },
        "fees": 0,
        "platformFees": 0,
        "reconciliationInstructions": { "transactionHash": "43T5oN1GC2xH4LkpsxwtFE7HqWBRjcejKYGbAgaDLJUZriCWTis8NBDG8D2WQBpXYpbXgvYP6d7syisQRxBVwdDH" },
        "paymentInstructions": [ { "accountOrWalletInfo": { "accountType": "USD_ACCOUNT", "accountNumber": "1111222233331111", "routingNumber": "021000021", "paymentRails": ["ACH", "WIRE", "RTP", "FEDNOW"], "reference": "2e25247b-37b2-4563-a3e9-788e4334a4e5" } } ],
        "paymentRail": null,
        "railSelectionMode": "AUTO",
        "expectedSettlementAt": null,
        "settlementTimelineSeconds": null
    },
    "id": "Webhook:01a05d38-7c54-52c1-0000-38d8e1f445d8",
    "type": "OUTGOING_PAYMENT.COMPLETED",
    "timestamp": "2026-09-01T13:46:18.068932Z"
}`;

const processor = new LightsparkWebhookProcessor();
const appContext = { env } as unknown as AppContext;

async function seedTransfer() {
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "Lightspark Webhook Test",
        "lightspark-webhook-test",
        "enterprise",
        "active"
      ),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "lightspark-webhook@example.com", 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        PROJECT_ID,
        ORGANIZATION_ID,
        "Lightspark Webhook Project",
        "lightspark-webhook-project",
        "sandbox",
        "active",
        USER_ID
      ),
    getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, source_address,
           destination_address, token, amount, memo, type, direction, status,
           provider, provider_reference, delivery_mode, fiat_currency,
           fiat_amount, provider_data, signature, serialized_tx,
           initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`
      )
      .bind(
        TRANSFER_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        "wallet_lightspark_webhook_test",
        null,
        DESTINATION_ADDRESS,
        "USDC",
        null,
        null,
        "onramp",
        "inbound",
        "awaiting_payment",
        "lightspark",
        QUOTE_ID,
        "manual_instructions",
        "USD",
        "10",
        {},
        null,
        null,
        null,
        "2026-09-01T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z"
      ),
  ]);
}

describe("LightsparkWebhookProcessor", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
  });

  it("parses the real completed transaction payload", () => {
    expect(processor.parse(REAL_COMPLETED_PAYLOAD)).toEqual({
      provider: "lightspark",
      kind: "settled",
      reference: QUOTE_ID,
      providerCustomerId: "Customer:01a05d36-8279-938e-0000-d5b3cdf7c5fa",
      onchain: {
        signature:
          "43T5oN1GC2xH4LkpsxwtFE7HqWBRjcejKYGbAgaDLJUZriCWTis8NBDG8D2WQBpXYpbXgvYP6d7syisQRxBVwdDH",
      },
      receivedAmount: "10",
      settlement: {
        provider: "lightspark",
        status: "COMPLETED",
        sentAmount: { amount: 1000, currencyCode: "USD", decimals: 2 },
        receivedAmount: { amount: 10000000, currencyCode: "USDC", decimals: 6 },
        exchangeRate: 0.0001,
        fees: 0,
        settledAt: "2026-09-01T13:46:18.026988Z",
      },
    });
  });

  it("maps an outgoing payment failure to a failed settlement", () => {
    const payload = REAL_COMPLETED_PAYLOAD.replace(
      "OUTGOING_PAYMENT.COMPLETED",
      "OUTGOING_PAYMENT.FAILED"
    )
      .replace('"status": "COMPLETED"', '"status": "FAILED"')
      .replace('"fees": 0,', '"failureReason": "BANK_REJECTED",\n        "fees": 0,');
    expect(processor.parse(payload)).toMatchObject({
      provider: "lightspark",
      kind: "failed",
      reference: QUOTE_ID,
      error: "BANK_REJECTED",
      settlement: { status: "FAILED" },
    });
  });

  it("settles the transfer whose quote reference the event carries, idempotently", async () => {
    await seedTransfer();
    await processor.process(appContext, "sandbox", processor.parse(REAL_COMPLETED_PAYLOAD));
    await processor.process(appContext, "sandbox", processor.parse(REAL_COMPLETED_PAYLOAD));

    const transfer = await getDb(env)
      .prepare(
        "SELECT status, amount, destination_address, signature, provider_reference, provider_data FROM payment_transfers WHERE id = ?"
      )
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        amount: string | null;
        destination_address: string | null;
        signature: string | null;
        provider_reference: string | null;
        provider_data: { settlement?: { settledAt?: string } };
      }>();
    expect(transfer).toMatchObject({
      status: "completed",
      amount: "10",
      destination_address: DESTINATION_ADDRESS,
      signature:
        "43T5oN1GC2xH4LkpsxwtFE7HqWBRjcejKYGbAgaDLJUZriCWTis8NBDG8D2WQBpXYpbXgvYP6d7syisQRxBVwdDH",
      provider_reference: QUOTE_ID,
      provider_data: { settlement: { settledAt: "2026-09-01T13:46:18.026988Z" } },
    });
  });

  it("ignores an event whose quote reference matches no transfer", async () => {
    await seedTransfer();
    const payload = REAL_COMPLETED_PAYLOAD.replace(
      `"quoteId": "${QUOTE_ID}"`,
      '"quoteId": "Quote:unknown"'
    );
    await processor.process(appContext, "sandbox", processor.parse(payload));

    const transfer = await getDb(env)
      .prepare("SELECT status, signature, provider_reference FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; signature: string | null; provider_reference: string | null }>();
    expect(transfer).toEqual({
      status: "awaiting_payment",
      signature: null,
      provider_reference: QUOTE_ID,
    });
  });
});
