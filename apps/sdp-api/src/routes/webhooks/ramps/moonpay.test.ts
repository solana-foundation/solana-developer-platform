import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { MoonpayWebhookProcessor } from "./moonpay";
import type { AppContext } from "./processor";

const ORGANIZATION_ID = "org_moonpay_webhook_test";
const PROJECT_ID = "prj_moonpay_webhook_test";
const USER_ID = "usr_moonpay_webhook_test";
const TRANSFER_ID = "xfr_157805c4-5d9f-404c-b206-1b59b13b492e";
const MOONPAY_TRANSACTION_ID = "772f7a7f-142e-43cf-824f-8d861aefe8bd";

describe("MoonpayWebhookProcessor.process", () => {
  const processor = new MoonpayWebhookProcessor();
  const appContext = { env } as unknown as AppContext;

  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(
          ORGANIZATION_ID,
          "MoonPay Webhook Test",
          "moonpay-webhook-test",
          "enterprise",
          "active"
        ),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(USER_ID, "moonpay-webhook@example.com", 1, "active"),
      getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          PROJECT_ID,
          ORGANIZATION_ID,
          "MoonPay Webhook Project",
          "moonpay-webhook-project",
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
          "wallet_moonpay_webhook_test",
          "source",
          null,
          "SOL",
          "0.2",
          null,
          "offramp",
          "outbound",
          "pending",
          "moonpay",
          null,
          "hosted",
          "USD",
          null,
          {},
          null,
          null,
          null,
          "2026-08-31T00:00:00.000Z",
          "2026-08-31T00:00:00.000Z"
        ),
    ]);
  });

  it("binds MoonPay's transaction id before applying the shared settlement event", async () => {
    const event = {
      provider: "moonpay",
      kind: "awaiting_payment",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
    } as const;

    await processor.process(appContext, "sandbox", event);
    await processor.process(appContext, "sandbox", event);
    await processor.process(appContext, "sandbox", {
      ...event,
      reference: "different-moonpay-transaction",
    });

    const row = await getDb(env)
      .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_reference: string | null }>();
    expect(row).toEqual({
      status: "awaiting_payment",
      provider_reference: MOONPAY_TRANSACTION_ID,
    });
  });
});
