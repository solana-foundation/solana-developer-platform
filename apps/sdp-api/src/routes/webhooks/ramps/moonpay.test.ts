import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import * as repositoryFactory from "@/db/repositories/repository-factory";
import { RedisKVStore } from "@/runtime/kv-redis";
import * as events from "@/runtime/money-path-events";
import type { ManagedRampKeysEnv } from "@/services/ramps/runtime";
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
const SECOND_TRANSFER_ID = "xfr_second_moonpay_buy";

const auditMetadataSchema = z.record(z.string(), z.unknown());

async function readRampAudits(transferId: string) {
  const { results } = await getDb(env)
    .prepare("SELECT action, metadata FROM audit_logs WHERE resource_id = ? ORDER BY created_at")
    .bind(transferId)
    .all<{ action: string; metadata: string }>();
  return results.map((row) => ({
    action: row.action,
    metadata: auditMetadataSchema.parse(JSON.parse(row.metadata)),
  }));
}

async function seedTwoBuyTransfers() {
  await getDb(env)
    .prepare("UPDATE payment_transfers SET type = 'onramp', direction = 'inbound' WHERE id = ?")
    .bind(TRANSFER_ID)
    .run();
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, source_address, destination_address,
         token, amount, memo, type, direction, status, provider, provider_reference,
         delivery_mode, fiat_currency, fiat_amount, provider_data, serialized_tx, signature,
         slot, created_at, updated_at
       ) SELECT ?, organization_id, project_id, wallet_id, source_address,
                destination_address, token, amount, memo, type, direction, status,
                provider, provider_reference, delivery_mode, fiat_currency, fiat_amount,
                provider_data, serialized_tx, signature, slot, created_at, updated_at
         FROM payment_transfers WHERE id = ?`
    )
    .bind(SECOND_TRANSFER_ID, TRANSFER_ID)
    .run();
}

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

  it("refuses a failed buy whose transaction id belongs to another transfer", async () => {
    await seedTwoBuyTransfers();
    const event = {
      provider: "moonpay",
      kind: "awaiting_payment",
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
        transferId: SECOND_TRANSFER_ID,
        providerObservedAt: "2026-08-31T11:01:00.000Z",
      })
    ).toEqual({ outcome: "refused", reason: "provider_reference_conflict" });
    expect(
      await getDb(env)
        .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
        .bind(SECOND_TRANSFER_ID)
        .first()
    ).toEqual({ status: "pending", provider_reference: null });
    expect(
      await getDb(env)
        .prepare("SELECT transaction_id FROM moonpay_failed_transactions WHERE transaction_id = ?")
        .bind(MOONPAY_TRANSACTION_ID)
        .first()
    ).toBeNull();
    expect(
      await processor.process(env, "sandbox", {
        ...event,
        kind: "settled",
        providerObservedAt: "2026-08-31T11:02:00.000Z",
      })
    ).toMatchObject({ outcome: "applied" });
  });

  it("lets one transfer own a transaction id when a claim races a failed buy", async () => {
    await seedTwoBuyTransfers();
    const event = {
      provider: "moonpay",
      kind: "awaiting_payment",
      rampType: "onramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: OBSERVED_AT,
    } as const;
    const [claim, failure] = await Promise.all([
      processor.process(env, "sandbox", event),
      processor.process(env, "sandbox", {
        ...event,
        kind: "failed",
        transferId: SECOND_TRANSFER_ID,
      }),
    ]);
    expect([claim.outcome, failure.outcome].sort()).toEqual(["applied", "refused"]);
    expect(claim.outcome === "applied" ? failure.reason : claim.reason).toBe(
      "provider_reference_conflict"
    );
    const owner = await getDb(env)
      .prepare("SELECT transfer_id FROM moonpay_failed_transactions WHERE transaction_id = ?")
      .bind(MOONPAY_TRANSACTION_ID)
      .first<{ transfer_id: string }>();
    const bound = await getDb(env)
      .prepare("SELECT id FROM payment_transfers WHERE provider_reference = ?")
      .bind(MOONPAY_TRANSACTION_ID)
      .first<{ id: string }>();
    expect(owner?.transfer_id ?? bound?.id).toBe(
      claim.outcome === "applied" ? TRANSFER_ID : SECOND_TRANSFER_ID
    );
    expect(owner === null || bound === null).toBe(true);
  });

  it("keeps a first failed buy id reserved after releasing its transfer", async () => {
    await seedTwoBuyTransfers();
    const event = {
      provider: "moonpay",
      kind: "failed",
      rampType: "onramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: SECOND_TRANSFER_ID,
      providerObservedAt: OBSERVED_AT,
    } as const;
    expect(await processor.process(env, "sandbox", event)).toEqual({ outcome: "applied" });
    expect(
      await processor.process(env, "sandbox", {
        ...event,
        kind: "awaiting_payment",
        transferId: TRANSFER_ID,
        providerObservedAt: "2026-08-31T11:01:00.000Z",
      })
    ).toEqual({ outcome: "refused", reason: "provider_reference_conflict" });
    expect(
      await getDb(env)
        .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
        .bind(TRANSFER_ID)
        .first()
    ).toEqual({ status: "pending", provider_reference: null });
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

  it("withdraws a failed sale's deposit instruction without losing its reference", async () => {
    const waiting = {
      provider: "moonpay",
      kind: "awaiting_payment",
      rampType: "offramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: OBSERVED_AT,
      cryptoDeposit: { destinationAddress: "moonpay-deposit-wallet", amount: "0.2" },
    } as const;
    expect(await processor.process(env, "sandbox", waiting)).toMatchObject({ outcome: "applied" });

    const failed = {
      ...waiting,
      kind: "failed",
      providerObservedAt: "2026-08-31T11:01:00.000Z",
      error: "sale_failed",
    } as const;
    expect(await processor.process(env, "sandbox", failed)).toEqual({
      outcome: "refused",
      reason: "moonpay_sell_failed",
    });
    const row = await getDb(env)
      .prepare(
        "SELECT status, provider_reference, provider_observed_at, provider_data FROM payment_transfers WHERE id = ?"
      )
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        provider_reference: string | null;
        provider_observed_at: string | null;
        provider_data: Record<string, unknown>;
      }>();
    expect(row).toMatchObject({
      status: "failed",
      provider_reference: MOONPAY_TRANSACTION_ID,
      provider_observed_at: failed.providerObservedAt,
      provider_data: { cryptoDeposit: null },
    });
    expect(await processor.process(env, "sandbox", waiting)).toEqual({ outcome: "ignored" });
    expect(
      await processor.process(env, "sandbox", {
        ...waiting,
        providerObservedAt: "2026-08-31T11:02:00.000Z",
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_terminal_conflict" });
  });

  it("holds MoonPay's failure on a claimed sale and keeps the claim open", async () => {
    const waiting = {
      provider: "moonpay",
      kind: "awaiting_payment",
      rampType: "offramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: OBSERVED_AT,
      cryptoDeposit: { destinationAddress: "moonpay-deposit-wallet", amount: "0.2" },
    } as const;
    expect(await processor.process(env, "sandbox", waiting)).toMatchObject({ outcome: "applied" });
    const claimed = await repositoryFactory
      .createSystemPaymentsRepository(env)
      .transitionRampTransfer({
        transferId: TRANSFER_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        transition: "offramp_deposit_claimed",
        updatedAt: "2026-08-31T11:01:00.000Z",
      });
    expect(claimed?.status).toBe("processing");

    expect(
      await processor.process(env, "sandbox", {
        ...waiting,
        kind: "failed",
        providerObservedAt: "2026-08-31T11:02:00.000Z",
        error: "deposit_timeout",
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_sell_failed" });
    const row = await getDb(env)
      .prepare(
        "SELECT status, provider_reference, provider_data FROM payment_transfers WHERE id = ?"
      )
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_reference: string | null; provider_data: object }>();
    expect(row).toMatchObject({
      status: "processing",
      provider_reference: MOONPAY_TRANSACTION_ID,
      provider_data: {
        cryptoDeposit: null,
        providerFailure: {
          reference: MOONPAY_TRANSACTION_ID,
          observedAt: "2026-08-31T11:02:00.000Z",
          error: "deposit_timeout",
        },
      },
    });
    expect(await readRampAudits(TRANSFER_ID)).toEqual([
      {
        action: "update",
        metadata: expect.objectContaining({
          transition: "moonpay_sell_failed_while_claimed",
          fromStatus: "processing",
        }),
      },
    ]);
  });

  it("keeps a failed sale with a reported deposit open for reconciliation", async () => {
    const waiting = {
      provider: "moonpay",
      kind: "awaiting_payment",
      rampType: "offramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: OBSERVED_AT,
      cryptoDeposit: { destinationAddress: "moonpay-deposit-wallet", amount: "0.2" },
    } as const;
    expect(await processor.process(env, "sandbox", waiting)).toMatchObject({ outcome: "applied" });

    expect(
      await processor.process(env, "sandbox", {
        ...waiting,
        kind: "failed",
        providerObservedAt: "2026-08-31T11:01:00.000Z",
        onchain: { signature: "moonpay-deposit-hash" },
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_sell_failed" });
    const row = await getDb(env)
      .prepare(
        "SELECT status, provider_reference, signature, provider_data FROM payment_transfers WHERE id = ?"
      )
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        provider_reference: string | null;
        signature: string | null;
        provider_data: Record<string, unknown>;
      }>();
    expect(row).toMatchObject({
      status: "settling",
      provider_reference: MOONPAY_TRANSACTION_ID,
      signature: null,
      provider_data: {
        cryptoDeposit: null,
        observedDelivery: { onchain: { signature: "moonpay-deposit-hash" } },
      },
    });
  });

  it("holds a deposit reported by the first failed sale observation", async () => {
    expect(
      await processor.process(env, "sandbox", {
        provider: "moonpay",
        kind: "failed",
        rampType: "offramp",
        reference: MOONPAY_TRANSACTION_ID,
        transferId: TRANSFER_ID,
        providerObservedAt: OBSERVED_AT,
        onchain: { signature: "moonpay-first-deposit-hash" },
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_sell_failed" });
    const row = await getDb(env)
      .prepare(
        "SELECT status, provider_reference, signature, provider_data FROM payment_transfers WHERE id = ?"
      )
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        provider_reference: string | null;
        signature: string | null;
        provider_data: Record<string, unknown>;
      }>();
    expect(row).toMatchObject({
      status: "settling",
      provider_reference: MOONPAY_TRANSACTION_ID,
      signature: null,
      provider_data: {
        cryptoDeposit: null,
        observedDelivery: { onchain: { signature: "moonpay-first-deposit-hash" } },
      },
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
    await getDb(env)
      .prepare(
        "UPDATE moonpay_failed_transactions SET status = 'archived' WHERE transaction_id = ?"
      )
      .bind(MOONPAY_TRANSACTION_ID)
      .run();
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

  it("refuses a first failed-buy observation that already reports crypto delivery", async () => {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET type = 'onramp', direction = 'inbound' WHERE id = ?")
      .bind(TRANSFER_ID)
      .run();
    expect(
      await processor.process(env, "sandbox", {
        provider: "moonpay",
        kind: "failed",
        rampType: "onramp",
        reference: MOONPAY_TRANSACTION_ID,
        transferId: TRANSFER_ID,
        providerObservedAt: OBSERVED_AT,
        onchain: { signature: "funded-buy-signature" },
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_failure_after_funding" });
    const row = await getDb(env)
      .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_reference: string | null }>();
    expect(row).toEqual({ status: "pending", provider_reference: null });
  });

  it("refuses a first failed-buy observation with a provider crypto transaction id", async () => {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET type = 'onramp', direction = 'inbound' WHERE id = ?")
      .bind(TRANSFER_ID)
      .run();
    expect(
      await processor.process(env, "sandbox", {
        provider: "moonpay",
        kind: "failed",
        rampType: "onramp",
        reference: MOONPAY_TRANSACTION_ID,
        transferId: TRANSFER_ID,
        providerObservedAt: OBSERVED_AT,
        settlement: {
          provider: "moonpay",
          status: "failed",
          transactionId: MOONPAY_TRANSACTION_ID,
          baseCurrencyCode: "USD",
          baseCurrencyAmount: 25,
          quoteCurrencyCode: "SOL",
          quoteCurrencyAmount: 0.2,
          feeAmount: 1,
          extraFeeAmount: 0,
          networkFeeAmount: 0,
          areFeesIncluded: true,
          usdRate: 125,
          cryptoTransactionId: "provider-crypto-id",
        },
      })
    ).toEqual({ outcome: "refused", reason: "moonpay_failure_after_funding" });
    const row = await getDb(env)
      .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_reference: string | null }>();
    expect(row).toEqual({ status: "pending", provider_reference: null });
  });

  it("records a failed buy in the audit ledger with its transfer writes", async () => {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET type = 'onramp', direction = 'inbound' WHERE id = ?")
      .bind(TRANSFER_ID)
      .run();
    const waiting = {
      provider: "moonpay",
      kind: "awaiting_payment",
      rampType: "onramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: "2026-08-31T10:59:00.000Z",
    } as const;
    expect(await processor.process(env, "sandbox", waiting)).toMatchObject({ outcome: "applied" });

    expect(
      await processor.process(env, "sandbox", {
        ...waiting,
        kind: "failed",
        providerObservedAt: OBSERVED_AT,
        error: "card_declined",
      })
    ).toEqual({ outcome: "applied" });

    expect(await readRampAudits(TRANSFER_ID)).toEqual([
      {
        action: "update",
        metadata: expect.objectContaining({
          transition: "moonpay_attempt_failed",
          fromStatus: "awaiting_payment",
          attemptReference: MOONPAY_TRANSACTION_ID,
        }),
      },
    ]);
  });

  it("rolls back all of a failed buy's writes when its audit row can't seal", async () => {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET type = 'onramp', direction = 'inbound' WHERE id = ?")
      .bind(TRANSFER_ID)
      .run();
    const waiting = {
      provider: "moonpay",
      kind: "awaiting_payment",
      rampType: "onramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: "2026-08-31T10:59:00.000Z",
    } as const;
    expect(await processor.process(env, "sandbox", waiting)).toMatchObject({ outcome: "applied" });
    // The ledger's pending witness is refused, so the record never seals.
    vi.spyOn(RedisKVStore.prototype, "compareAndSet").mockResolvedValueOnce(false);

    await expect(
      processor.process(env, "sandbox", {
        ...waiting,
        kind: "failed",
        providerObservedAt: OBSERVED_AT,
      })
    ).rejects.toThrow();

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
      provider_observed_at: waiting.providerObservedAt,
    });
    const retired = await getDb(env)
      .prepare("SELECT transaction_id FROM moonpay_failed_transactions WHERE transaction_id = ?")
      .bind(MOONPAY_TRANSACTION_ID)
      .first();
    expect(retired).toBeNull();
    expect(await readRampAudits(TRANSFER_ID)).toEqual([]);
  });

  it("rolls back a failed buy when recording its retired id fails", async () => {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET type = 'onramp', direction = 'inbound' WHERE id = ?")
      .bind(TRANSFER_ID)
      .run();
    const event = {
      provider: "moonpay",
      kind: "awaiting_payment",
      rampType: "onramp",
      reference: MOONPAY_TRANSACTION_ID,
      transferId: TRANSFER_ID,
      providerObservedAt: "2026-08-31T10:59:00.000Z",
    } as const;
    expect(await processor.process(env, "sandbox", event)).toMatchObject({ outcome: "applied" });

    const original = repositoryFactory.createSystemTransactionalPaymentsRepository;
    vi.spyOn(repositoryFactory, "createSystemTransactionalPaymentsRepository").mockImplementation(
      (db) => ({
        ...original(db),
        recordFailedMoonpayTransaction: async () => {
          throw new Error("forced retired-id write failure");
        },
      })
    );
    await expect(
      processor.process(env, "sandbox", {
        ...event,
        kind: "failed",
        providerObservedAt: OBSERVED_AT,
      })
    ).rejects.toThrow("forced retired-id write failure");

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
      provider_observed_at: event.providerObservedAt,
    });
    const retired = await getDb(env)
      .prepare("SELECT transaction_id FROM moonpay_failed_transactions WHERE transaction_id = ?")
      .bind(MOONPAY_TRANSACTION_ID)
      .first();
    expect(retired).toBeNull();
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
    expect(row).toEqual({ status: "failed", provider_reference: MOONPAY_TRANSACTION_ID });
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
  const SANDBOX_SECRET = "wk_test_moonpay_sandbox";
  const PRODUCTION_SECRET = "wk_live_moonpay_production";

  /** Verifies a body signed with `secret` at the production endpoint. */
  function verifyAtProduction(env: ManagedRampKeysEnv, secret: string) {
    const rawBody = "{}";
    const timestamp = Math.floor(Date.now() / 1000);
    const s = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    return moonpayWebhook.verify({
      env,
      environment: "production",
      headers: new Headers({ "moonpay-signature-v2": `t=${timestamp},s=${s}` }),
      rawBody,
    });
  }

  it("refuses the production endpoint while no production secret is mounted", async () => {
    await expect(
      verifyAtProduction({ MOONPAY_SANDBOX_WEBHOOK_SECRET: SANDBOX_SECRET }, SANDBOX_SECRET)
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("refuses a test-mode key mounted as the production secret", async () => {
    await expect(
      verifyAtProduction({ MOONPAY_PRODUCTION_WEBHOOK_SECRET: SANDBOX_SECRET }, SANDBOX_SECRET)
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("verifies the production endpoint with the production secret, never the sandbox one", async () => {
    const env = {
      MOONPAY_SANDBOX_WEBHOOK_SECRET: SANDBOX_SECRET,
      MOONPAY_PRODUCTION_WEBHOOK_SECRET: PRODUCTION_SECRET,
    } satisfies ManagedRampKeysEnv;
    await expect(verifyAtProduction(env, SANDBOX_SECRET)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(verifyAtProduction(env, PRODUCTION_SECRET)).resolves.toBe("{}");
  });
});
