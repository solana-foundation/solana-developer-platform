import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import * as events from "@/runtime/money-path-events";
import { moonpayWebhook } from "@/services/ramps/webhooks/moonpay";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION_ID = "org_moonpay_webhook_test";
const PROJECT_ID = "prj_moonpay_webhook_test";
const USER_ID = "usr_moonpay_webhook_test";
const TRANSFER_ID = "xfr_157805c4-5d9f-404c-b206-1b59b13b492e";
const MOONPAY_TRANSACTION_ID = "772f7a7f-142e-43cf-824f-8d861aefe8bd";
const OBSERVED_AT = "2026-08-31T11:00:00.000Z";

describe("moonpayWebhook.process", () => {
  const processor = moonpayWebhook;

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: ORGANIZATION_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
    await getDb(env).batch([
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
      rampType: "offramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: OBSERVED_AT,
    } as const;

    expect(await processor.process(env, "sandbox", event)).toMatchObject({ outcome: "applied" });
    expect(await processor.process(env, "sandbox", event)).toEqual({ outcome: "ignored" });
    expect(
      await processor.process(env, "sandbox", {
        ...event,
        reference: "different-moonpay-transaction",
      })
    ).toEqual({ outcome: "refused", reason: "provider_reference_conflict" });

    const row = await getDb(env)
      .prepare(
        "SELECT status, provider_reference, provider_observed_at FROM payment_transfers WHERE id = ?"
      )
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        provider_reference: string | null;
        provider_observed_at: string | null;
      }>();
    expect(row).toEqual({
      status: "awaiting_payment",
      provider_reference: MOONPAY_TRANSACTION_ID,
      provider_observed_at: OBSERVED_AT,
    });
  });

  it("lets only one of two concurrent MoonPay ids claim a transfer", async () => {
    const event = {
      provider: "moonpay",
      kind: "awaiting_payment",
      rampType: "offramp",
      transferId: TRANSFER_ID,
      providerObservedAt: OBSERVED_AT,
    } as const;
    const results = await Promise.all([
      processor.process(env, "sandbox", { ...event, reference: "moonpay-first" }),
      processor.process(env, "sandbox", { ...event, reference: "moonpay-second" }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["applied", "refused"]);
    expect(results.find((result) => result.outcome === "refused")).toEqual({
      outcome: "refused",
      reason: "provider_reference_conflict",
    });
    const row = await getDb(env)
      .prepare(
        "SELECT provider_reference, provider_observed_at FROM payment_transfers WHERE id = ?"
      )
      .bind(TRANSFER_ID)
      .first<{ provider_reference: string; provider_observed_at: string }>();
    expect(["moonpay-first", "moonpay-second"]).toContain(row?.provider_reference);
    expect(row?.provider_observed_at).toBe(OBSERVED_AT);
  });

  it("keeps the newest deposit instruction for one sale", async () => {
    const event = {
      provider: "moonpay",
      kind: "awaiting_payment",
      rampType: "offramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: "2026-08-31T11:02:00.000Z",
      cryptoDeposit: { destinationAddress: "new-wallet", amount: "0.2" },
    } as const;
    expect(await processor.process(env, "sandbox", event)).toMatchObject({ outcome: "applied" });
    expect(
      await processor.process(env, "sandbox", {
        ...event,
        providerObservedAt: OBSERVED_AT,
        cryptoDeposit: { destinationAddress: "stale-wallet", amount: "0.2" },
      })
    ).toEqual({ outcome: "ignored" });
    const row = await getDb(env)
      .prepare("SELECT provider_observed_at, provider_data FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ provider_observed_at: string; provider_data: Record<string, unknown> }>();
    expect(row).toMatchObject({
      provider_observed_at: event.providerObservedAt,
      provider_data: { cryptoDeposit: event.cryptoDeposit },
    });
  });

  it("retires a failed buy id and lets a new buy id claim the transfer", async () => {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET type = 'onramp', direction = 'inbound' WHERE id = ?")
      .bind(TRANSFER_ID)
      .run();
    const failed = {
      provider: "moonpay",
      kind: "failed",
      rampType: "onramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: OBSERVED_AT,
      error: "card_declined",
    } as const;
    expect(
      await processor.process(env, "sandbox", {
        ...failed,
        kind: "awaiting_payment",
        providerObservedAt: "2026-08-31T10:59:00.000Z",
      })
    ).toMatchObject({ outcome: "applied" });
    expect(await processor.process(env, "sandbox", failed)).toEqual({ outcome: "applied" });
    const released = await getDb(env)
      .prepare(
        "SELECT status, provider_reference, provider_observed_at FROM payment_transfers WHERE id = ?"
      )
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        provider_reference: string | null;
        provider_observed_at: string | null;
      }>();
    expect(released).toEqual({
      status: "awaiting_payment",
      provider_reference: null,
      provider_observed_at: null,
    });
    expect(await processor.process(env, "sandbox", failed)).toEqual({ outcome: "ignored" });
    expect(
      await processor.process(env, "sandbox", {
        ...failed,
        kind: "settled",
        providerObservedAt: "2026-08-31T11:01:00.000Z",
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_attempt_revived" });
    expect(
      await processor.process(env, "sandbox", {
        ...failed,
        kind: "awaiting_payment",
        reference: "new-moonpay-buy-id",
        providerObservedAt: "2026-08-31T11:02:00.000Z",
      })
    ).toMatchObject({ outcome: "applied" });
    const row = await getDb(env)
      .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_reference: string | null }>();
    expect(row).toEqual({ status: "awaiting_payment", provider_reference: "new-moonpay-buy-id" });
  });

  it("holds a sale failure for review while its deposit may still arrive", async () => {
    expect(
      await processor.process(env, "sandbox", {
        provider: "moonpay",
        kind: "failed",
        rampType: "offramp",
        reference: MOONPAY_TRANSACTION_ID,
        transferId: TRANSFER_ID,
        providerObservedAt: OBSERVED_AT,
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_sell_failed" });
    const row = await getDb(env)
      .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_reference: string | null }>();
    expect(row).toEqual({ status: "pending", provider_reference: null });
  });

  it("refuses a buy webhook aimed at a sale transfer", async () => {
    expect(
      await processor.process(env, "sandbox", {
        provider: "moonpay",
        kind: "settled",
        rampType: "onramp",
        reference: MOONPAY_TRANSACTION_ID,
        transferId: TRANSFER_ID,
        providerObservedAt: OBSERVED_AT,
      })
    ).toEqual({ outcome: "refused", reason: "transfer_type_mismatch" });
    const row = await getDb(env)
      .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_reference: string | null }>();
    expect(row).toEqual({ status: "pending", provider_reference: null });
  });

  it("holds a buy failure after the provider reported payment activity", async () => {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET type = 'onramp', direction = 'inbound' WHERE id = ?")
      .bind(TRANSFER_ID)
      .run();
    const event = {
      provider: "moonpay",
      kind: "settling",
      rampType: "onramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: OBSERVED_AT,
    } as const;
    expect(await processor.process(env, "sandbox", event)).toMatchObject({ outcome: "applied" });
    expect(
      await processor.process(env, "sandbox", {
        ...event,
        kind: "failed",
        providerObservedAt: "2026-08-31T11:01:00.000Z",
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_failure_after_funding" });
    const row = await getDb(env)
      .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_reference: string | null }>();
    expect(row).toEqual({ status: "settling", provider_reference: MOONPAY_TRANSACTION_ID });
  });

  it.each([
    { transferEnvironment: "sandbox", eventEnvironment: "production" },
    { transferEnvironment: "production", eventEnvironment: "sandbox" },
  ] as const)(
    "logs and refuses a $eventEnvironment event aimed at a $transferEnvironment transfer",
    async ({ transferEnvironment, eventEnvironment }) => {
      if (transferEnvironment === "production") {
        await getDb(env)
          .prepare("UPDATE payment_transfers SET project_id = ? WHERE id = ?")
          .bind(`${PROJECT_ID}_production`, TRANSFER_ID)
          .run();
      }
      const logEvent = vi.spyOn(events, "logEvent").mockImplementation(() => {});

      const result = await processor.process(env, eventEnvironment, {
        provider: "moonpay",
        kind: "awaiting_payment",
        rampType: "offramp",
        reference: MOONPAY_TRANSACTION_ID,
        transferId: TRANSFER_ID,
        providerObservedAt: OBSERVED_AT,
      });

      expect(result).toEqual({ outcome: "refused", reason: "environment_mismatch" });
      expect(logEvent).toHaveBeenCalledWith("error", {
        event: "sdp_api_ramp_settlement_environment_mismatch",
        flow: "ramp-settlement",
        provider: "moonpay",
        provider_reference: MOONPAY_TRANSACTION_ID,
        transfer_id: TRANSFER_ID,
        environment: eventEnvironment,
        transfer_environment: transferEnvironment,
      });
      const row = await getDb(env)
        .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
        .bind(TRANSFER_ID)
        .first<{ status: string; provider_reference: string | null }>();
      expect(row).toEqual({ status: "pending", provider_reference: null });
    }
  );
});

describe("moonpayWebhook.verify", () => {
  it("refuses the production endpoint, which has no managed key", async () => {
    await expect(
      moonpayWebhook.verify({
        env: { MOONPAY_SANDBOX_WEBHOOK_KEY: "moonpay_sandbox_webhook_key" },
        environment: "production",
        headers: new Headers({ "moonpay-signature-v2": "t=1,s=deadbeef" }),
        rawBody: "{}",
      })
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });
});
