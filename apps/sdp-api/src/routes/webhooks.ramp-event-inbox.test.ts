import { createHmac } from "node:crypto";
import type { ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresRampWebhookEventsRepository } from "@/db/repositories/ramp-webhook-event.repository";
import app from "@/index";
import * as replayJobs from "@/services/jobs/replay-ramp-webhook-events";
import {
  applyStoredRampWebhookEvent,
  RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
  replayRampWebhookEvents,
} from "@/services/jobs/replay-ramp-webhook-events";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * The durable ramp webhook inbox: a verified event is persisted before the
 * 200 ack, discharged by the background apply, and replayed by the job when
 * the background pass never ran or failed. MoonPay stands in for every
 * provider — the inbox is provider-agnostic and sits above the processors.
 */
describe("Ramp webhook event inbox", () => {
  const ORG_ID = "org_ramp_inbox";
  const PROJECT_ID = "prj_ramp_inbox";
  const USER_ID = "usr_ramp_inbox";
  const TRANSFER_ID = "xfr_ramp_inbox";
  const MOONPAY_TRANSACTION_ID = "e3a1f7cb-42c1-4a08-9d5f-0d51e94eb1af";
  const MOONPAY_WEBHOOK_KEY = "moonpay_test_webhook_key";

  function moonpaySignatureHeader(body: string, timestampSeconds: number) {
    const s = createHmac("sha256", MOONPAY_WEBHOOK_KEY)
      .update(`${timestampSeconds}.${body}`)
      .digest("hex");
    return `t=${timestampSeconds},s=${s}`;
  }

  async function sendMoonpayWebhook(payload: unknown, options?: { settleBackground?: boolean }) {
    const body = JSON.stringify(payload);
    const header = moonpaySignatureHeader(body, Math.floor(Date.now() / 1000));
    const background: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/moonpay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Moonpay-Signature-V2": header },
        body,
      },
      env,
      executionCtx
    );
    if (options?.settleBackground !== false) {
      await Promise.allSettled(background);
    }
    return { res, background };
  }

  async function seedMoonpayOnrampTransfer() {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_ID, "Ramp Inbox Org", "ramp-inbox-org", "enterprise", "active")
      .run();
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "ramp-inbox-user@example.com", 1, "active")
      .run();
    await seedDefaultProjects(getDb(env), {
      organizationId: ORG_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, counterparty_id, source_address,
           destination_address, token, amount, memo, type, direction, status, provider,
           provider_reference, delivery_mode, fiat_currency, fiat_amount, provider_data,
           signature, serialized_tx, initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TRANSFER_ID,
        ORG_ID,
        PROJECT_ID,
        "wallet_ramp_inbox",
        null,
        null,
        "DestinationSolanaWallet111111111111111111111111",
        "SOL",
        null,
        null,
        "onramp",
        "inbound",
        "awaiting_payment",
        "moonpay",
        null,
        null,
        "USD",
        "47.73",
        {},
        null,
        null,
        null,
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z"
      )
      .run();
  }

  const completedPayload = {
    type: "transaction_updated",
    externalCustomerId: "MOONPAY-ONRAMP-0001",
    data: {
      id: MOONPAY_TRANSACTION_ID,
      status: "completed",
      externalTransactionId: TRANSFER_ID,
      failureReason: null,
      baseCurrencyAmount: 47.73,
      quoteCurrencyAmount: 0.649,
      walletAddress: "WebhookDestinationSolanaWallet111111111111111111",
      cryptoTransactionId: "t11paHKpm79qTHVgSQ4rr9PAqE7ZT87MWpi1f5Nim8XzPyc7aPux",
      baseCurrency: { code: "usd" },
      currency: { code: "sol" },
    },
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.MOONPAY_SANDBOX_WEBHOOK_KEY = MOONPAY_WEBHOOK_KEY;
    await seedMoonpayOnrampTransfer();
  });

  afterEach(async () => {
    env.MOONPAY_SANDBOX_WEBHOOK_KEY = undefined;
  });

  async function readInboxRows() {
    const result = await getDb(env)
      .prepare("SELECT id, status, attempts, last_error FROM ramp_webhook_events")
      .all<{ id: string; status: string; attempts: number; last_error: string | null }>();
    return result.results;
  }

  async function readTransferStatus() {
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string }>();
    return row?.status;
  }

  it("applies a delivered event and discharges its inbox row", async () => {
    // The insert-before-ack ordering itself is exercised by the replay tests
    // below: a row that survives an apply that never ran is exactly what they
    // seed. Here the whole path runs and must leave no row behind.
    const { res } = await sendMoonpayWebhook(completedPayload);
    expect(res.status).toBe(200);

    expect(await readTransferStatus()).toBe("completed");
    expect(await readInboxRows()).toHaveLength(0);
  });

  it("persists the event before acking even when the background apply never runs", async () => {
    const applySpy = vi
      .spyOn(replayJobs, "applyStoredRampWebhookEvent")
      .mockImplementation(async () => false);

    try {
      const { res } = await sendMoonpayWebhook(completedPayload);
      expect(res.status).toBe(200);

      const rows = await readInboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending");
      expect(await readTransferStatus()).toBe("awaiting_payment");
    } finally {
      applySpy.mockRestore();
    }
  });

  it("parks a pending row whose final claim crashed before applying", async () => {
    const stored = await createPostgresRampWebhookEventsRepository(getDb(env)).insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: completedPayload,
    });
    await getDb(env)
      .prepare(
        "UPDATE ramp_webhook_events SET attempts = ?, created_at = ?, updated_at = ? WHERE id = ?"
      )
      .bind(
        RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        stored.id
      )
      .run();

    const applied = await replayRampWebhookEvents(env);

    expect(applied).toBe(0);
    const rows = await readInboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(await readTransferStatus()).toBe("awaiting_payment");
  });

  it("replays a pending event the background apply never ran for", async () => {
    // Simulate the crash-after-ack window: the row exists, the apply did not
    // happen. Backdate it past the replay minimum age so the job claims it.
    const stored = await createPostgresRampWebhookEventsRepository(getDb(env)).insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: completedPayload,
    });
    await getDb(env)
      .prepare("UPDATE ramp_webhook_events SET created_at = ?, updated_at = ? WHERE id = ?")
      .bind("2026-06-18T00:00:00.000Z", "2026-06-18T00:00:00.000Z", stored.id)
      .run();

    const applied = await replayRampWebhookEvents(env);

    expect(applied).toBe(1);
    expect(await readTransferStatus()).toBe("completed");
    expect(await readInboxRows()).toHaveLength(0);
  });

  it("does not claim events still inside the background pass's window", async () => {
    await createPostgresRampWebhookEventsRepository(getDb(env)).insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: completedPayload,
    });

    const applied = await replayRampWebhookEvents(env);

    expect(applied).toBe(0);
    expect(await readTransferStatus()).toBe("awaiting_payment");
    expect(await readInboxRows()).toHaveLength(1);
  });

  it("re-arms rows parked by another revision and leaves current-revision parks alone", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const fromOldDeploy = await events.insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: completedPayload,
    });
    const fromNullRevision = await events.insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: { type: "transaction_updated", data: { status: 42 } },
    });
    const fromCurrentDeploy = await events.insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: { type: "transaction_updated", data: { status: 43 } },
    });
    await getDb(env)
      .prepare(
        `UPDATE ramp_webhook_events
           SET status = 'failed', attempts = 10,
               parked_app_revision = CASE id WHEN ? THEN 'rev-previous' WHEN ? THEN NULL ELSE ? END
         WHERE id IN (?, ?, ?)`
      )
      .bind(
        fromOldDeploy.id,
        fromNullRevision.id,
        env.API_VERSION ?? "local",
        fromOldDeploy.id,
        fromNullRevision.id,
        fromCurrentDeploy.id
      )
      .run();

    await replayRampWebhookEvents(env);

    const rows = await getDb(env)
      .prepare("SELECT id, status, attempts FROM ramp_webhook_events ORDER BY created_at ASC")
      .all<{ id: string; status: string; attempts: number }>();
    const byId = new Map(rows.results.map((row) => [row.id, row]));
    // Parked by an older deploy (or before revisions were stamped): the new
    // rollout may carry the fix, so both go back to pending with fresh
    // attempts for the next pass.
    expect(byId.get(fromOldDeploy.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(byId.get(fromNullRevision.id)).toMatchObject({ status: "pending", attempts: 0 });
    // Parked by the revision that is still running: same code, same payload —
    // stays parked.
    expect(byId.get(fromCurrentDeploy.id)).toMatchObject({ status: "failed" });
  });

  it("keeps a failing event pending with its error, then parks it after the last attempt", async () => {
    // A payload `parse` rejects stands in for any deterministic apply failure.
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const stored = await events.insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: { type: "transaction_updated", data: { status: 42 } },
    });

    expect(await applyStoredRampWebhookEvent(env, stored, 1)).toBe(false);
    let rows = await readInboxRows();
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.last_error).toBeTruthy();

    expect(await applyStoredRampWebhookEvent(env, stored, RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS)).toBe(
      false
    );
    rows = await readInboxRows();
    expect(rows[0]?.status).toBe("failed");
  });
});
