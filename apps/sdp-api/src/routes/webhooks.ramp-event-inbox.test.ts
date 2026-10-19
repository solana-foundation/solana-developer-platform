import { createHmac } from "node:crypto";
import {
  RETIRED_RAMP_PROVIDERS,
  SDP_RAMP_PROVIDER_STAGES,
  type SdpRampProviderStages,
  wellKnownMint,
} from "@sdp/types";
import type { ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { getDb } from "@/db";
import { createPostgresRampWebhookEventsRepository } from "@/db/repositories/ramp-webhook-event.repository";
import app from "@/index";
import { noopObservability } from "@/runtime/observability";
import * as replayJobs from "@/services/jobs/replay-ramp-webhook-events";
import {
  applyStoredRampWebhookEvent,
  RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
  replayRampWebhookEvents,
} from "@/services/jobs/replay-ramp-webhook-events";
import { TerminalRampWebhookError } from "@/services/ramps/webhooks/processor";
import { RAMP_PROVIDER_WEBHOOK_PROCESSOR } from "@/services/ramps/webhooks/registry";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

/**
 * The durable ramp webhook inbox: a verified event is persisted before the
 * 200 ack, discharged by the background apply, and replayed by the job when
 * the background pass never ran or failed.
 */
describe("Ramp webhook event inbox", () => {
  const ORG_ID = "org_ramp_inbox";
  const PROJECT_ID = "prj_ramp_inbox";
  const USER_ID = "usr_ramp_inbox";
  const TRANSFER_ID = "xfr_ramp_inbox";
  const MOONPAY_TRANSACTION_ID = "e3a1f7cb-42c1-4a08-9d5f-0d51e94eb1af";
  const MOONPAY_WEBHOOK_KEY = "moonpay_test_webhook_key";
  const STRIPE_WEBHOOK_SECRET = "whsec_ramp_inbox_test";
  function solMint(): string {
    const mint = wellKnownMint("SOL", "devnet");
    if (mint === undefined) {
      throw new Error("SOL has no devnet mint in the catalogue");
    }
    return mint;
  }

  function moonpaySignatureHeader(body: string, timestampSeconds: number) {
    const s = createHmac("sha256", MOONPAY_WEBHOOK_KEY)
      .update(`${timestampSeconds}.${body}`)
      .digest("hex");
    return `t=${timestampSeconds},s=${s}`;
  }

  async function sendMoonpayWebhook(
    payload: unknown,
    options?: {
      rawBody?: string;
      settleBackground?: boolean;
      target?: { app: typeof app; env: Env };
    }
  ) {
    const body = options?.rawBody ?? JSON.stringify(payload);
    const header = moonpaySignatureHeader(body, Math.floor(Date.now() / 1000));
    const background: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const target = options?.target ?? { app, env };
    const res = await target.app.request(
      "/webhooks/payments/ramps/sandbox/moonpay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Moonpay-Signature-V2": header },
        body,
      },
      target.env,
      executionCtx
    );
    if (options?.settleBackground !== false) {
      await Promise.allSettled(background);
    }
    return { res, background };
  }

  async function sendStripeWebhook(rawBody: string) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const background: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/stripe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": `t=${timestamp},v1=${signature}`,
        },
        body: rawBody,
      },
      env,
      executionCtx
    );
    await Promise.allSettled(background);
    return res;
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
        solMint(),
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
    env.STRIPE_SANDBOX_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET;
    await seedMoonpayOnrampTransfer();
  });

  afterEach(async () => {
    env.MOONPAY_SANDBOX_WEBHOOK_KEY = undefined;
    env.STRIPE_SANDBOX_WEBHOOK_SECRET = undefined;
  });

  async function readInboxRows() {
    const result = await getDb(env)
      .prepare(
        "SELECT id, status, attempts, last_error, apply_outcome, provider_event_id, raw_body FROM ramp_webhook_events"
      )
      .all<{
        id: string;
        status: string;
        attempts: number;
        last_error: string | null;
        apply_outcome: string | null;
        provider_event_id: string | null;
        raw_body: string | null;
      }>();
    return result.results;
  }

  async function readTransferStatus() {
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string }>();
    return row?.status;
  }

  it("applies a delivered event and retains its outcome", async () => {
    // The insert-before-ack ordering itself is exercised by the replay tests
    // below: a row that survives an apply that never ran is exactly what they
    // seed. Here the whole path runs and must retain the outcome.
    const { res } = await sendMoonpayWebhook(completedPayload);
    expect(res.status).toBe(200);

    expect(await readTransferStatus()).toBe("completed");
    expect(await readInboxRows()).toMatchObject([
      {
        status: "discharged",
        apply_outcome: "applied",
        raw_body: null,
      },
    ]);
  });

  it("acks and records a signed malformed sandbox event as discarded", async () => {
    const { res } = await sendMoonpayWebhook(null, { rawBody: "{invalid-json" });
    expect(res.status).toBe(200);
    expect(await readInboxRows()).toMatchObject([
      {
        status: "discharged",
        apply_outcome: "discarded",
        raw_body: null,
        last_error: expect.any(String),
      },
    ]);
    expect(await readTransferStatus()).toBe("awaiting_payment");
  });

  it("stores a signed malformed Stripe event before discarding it in sandbox", async () => {
    expect((await sendStripeWebhook("{invalid-json")).status).toBe(200);
    expect(await readInboxRows()).toMatchObject([
      {
        status: "discharged",
        apply_outcome: "discarded",
        raw_body: null,
        last_error: expect.any(String),
      },
    ]);
  });

  it("inserts duplicate signed Stripe deliveries with one evt id only once", async () => {
    const rawBody = JSON.stringify({ id: "evt_inbox123", livemode: false, type: "ignored.event" });
    expect((await sendStripeWebhook(rawBody)).status).toBe(200);
    expect((await sendStripeWebhook(rawBody)).status).toBe(200);
    expect(await readInboxRows()).toMatchObject([
      { provider_event_id: "evt_inbox123", status: "discharged", apply_outcome: "ignored" },
    ]);
  });

  it("parks a signed malformed production event without applying it", async () => {
    const { row } = await createPostgresRampWebhookEventsRepository(getDb(env)).insertVerifiedEvent(
      {
        provider: "moonpay",
        environment: "production",
        rawBody: "{invalid-json",
        providerEventId: null,
      }
    );
    expect(await applyStoredRampWebhookEvent(env, row, 1)).toBe(false);
    expect(await readInboxRows()).toMatchObject([
      { status: "failed", apply_outcome: "invalid", attempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS },
    ]);
  });

  it("discards a sandbox event for an unknown transfer without alerting", async () => {
    const { res } = await sendMoonpayWebhook({
      ...completedPayload,
      data: { ...completedPayload.data, externalTransactionId: "xfr_not_yet_recorded" },
    });
    expect(res.status).toBe(200);
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "discarded", last_error: "provider event unmatched" },
    ]);
    expect(await readTransferStatus()).toBe("awaiting_payment");
  });

  it("retries an unmatched production event while the transfer may still arrive", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const stored = await events.insertEvent({
      provider: "moonpay",
      environment: "production",
      payload: {
        ...completedPayload,
        data: { ...completedPayload.data, externalTransactionId: "xfr_not_yet_recorded" },
      },
    });

    expect(await applyStoredRampWebhookEvent(env, stored, 1)).toBe(false);
    expect(await readInboxRows()).toMatchObject([
      { status: "pending", apply_outcome: "unmatched", attempts: 1 },
    ]);
  });

  it("discharges a redelivery for an already-final transfer as ignored", async () => {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET status = 'completed' WHERE id = ?")
      .bind(TRANSFER_ID)
      .run();
    const { res } = await sendMoonpayWebhook(completedPayload);
    expect(res.status).toBe(200);
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "ignored", attempts: 0 },
    ]);
    expect(await readTransferStatus()).toBe("completed");
  });

  it("does not dedupe providers without delivery ids", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const first = await events.insertVerifiedEvent({
      provider: "moonpay",
      environment: "sandbox",
      rawBody: JSON.stringify(completedPayload),
      providerEventId: null,
    });
    const second = await events.insertVerifiedEvent({
      provider: "moonpay",
      environment: "sandbox",
      rawBody: JSON.stringify(completedPayload),
      providerEventId: null,
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.row.id).not.toBe(first.row.id);
  });

  it("dedupes a provider delivery id within its environment", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const first = await events.insertVerifiedEvent({
      provider: "stripe",
      environment: "sandbox",
      rawBody: '{"id":"evt_one"}',
      providerEventId: "evt_one",
    });
    const second = await events.insertVerifiedEvent({
      provider: "stripe",
      environment: "sandbox",
      rawBody: '{"id":"evt_one"}',
      providerEventId: "evt_one",
    });
    const production = await events.insertVerifiedEvent({
      provider: "stripe",
      environment: "production",
      rawBody: '{"id":"evt_one"}',
      providerEventId: "evt_one",
    });
    expect(first.inserted).toBe(true);
    expect(second).toMatchObject({ inserted: false, row: { id: first.row.id } });
    expect(production.inserted).toBe(true);
    expect(await readInboxRows()).toHaveLength(2);
  });

  it("archives only discharged rows past retention", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const discharged = await events.insertVerifiedEvent({
      provider: "stripe",
      environment: "sandbox",
      rawBody: "{}",
      providerEventId: "evt_archive",
    });
    const pending = await events.insertVerifiedEvent({
      provider: "moonpay",
      environment: "sandbox",
      rawBody: "{}",
      providerEventId: null,
    });
    await events.dischargeEvent(discharged.row.id, "ignored");
    await getDb(env)
      .prepare("UPDATE ramp_webhook_events SET discharged_at = ? WHERE id = ?")
      .bind("2026-06-18T00:00:00.000Z", discharged.row.id)
      .run();
    expect(await events.archiveDischarged("2026-06-19T00:00:00.000Z", 100)).toBe(1);
    const rows = await readInboxRows();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pending.row.id, status: "pending" }),
        expect.objectContaining({
          id: discharged.row.id,
          status: "archived",
          apply_outcome: null,
          provider_event_id: null,
        }),
      ])
    );
    const redelivery = await events.insertVerifiedEvent({
      provider: "stripe",
      environment: "sandbox",
      rawBody: "{}",
      providerEventId: "evt_archive",
    });
    expect(redelivery.inserted).toBe(true);
    expect(redelivery.row.id).not.toBe(discharged.row.id);
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

    const applied = await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_STAGES);

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

    const applied = await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_STAGES);

    expect(applied).toBe(1);
    expect(await readTransferStatus()).toBe("completed");
    expect(await readInboxRows()).toMatchObject([{ status: "discharged" }]);
  });

  it("replays a legacy JSONB string without encoding it again", async () => {
    const rawBody = JSON.stringify(completedPayload);
    const stored = await createPostgresRampWebhookEventsRepository(getDb(env)).insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: rawBody,
    });

    expect(stored.rawBody).toBe(rawBody);
    expect(await applyStoredRampWebhookEvent(env, stored, 1)).toBe(true);
    expect(await readTransferStatus()).toBe("completed");
  });

  it("does not claim events still inside the background pass's window", async () => {
    await createPostgresRampWebhookEventsRepository(getDb(env)).insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: completedPayload,
    });

    const applied = await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_STAGES);

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
        env.SDP_BUILD_SHA?.trim() || "local",
        fromOldDeploy.id,
        fromNullRevision.id,
        fromCurrentDeploy.id
      )
      .run();

    await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_STAGES);

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

  it("never re-arms a terminal park, even one from another revision", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const stored = await events.insertEvent({
      provider: "moonpay",
      environment: "production",
      payload: completedPayload,
    });
    await getDb(env)
      .prepare(
        `UPDATE ramp_webhook_events
           SET status = 'failed', attempts = 10, terminal = TRUE,
               parked_app_revision = 'rev-previous'
         WHERE id = ?`
      )
      .bind(stored.id)
      .run();

    await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_STAGES);

    const row = await getDb(env)
      .prepare("SELECT status, attempts FROM ramp_webhook_events WHERE id = ?")
      .bind(stored.id)
      .first<{ status: string; attempts: number }>();
    expect(row).toMatchObject({ status: "failed", attempts: 10 });
  });

  it("keeps a transient failure pending, then parks it after the last attempt", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const stored = await events.insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: completedPayload,
    });
    const processSpy = vi
      .spyOn(RAMP_PROVIDER_WEBHOOK_PROCESSOR.moonpay, "process")
      .mockRejectedValue(new Error("temporary database error"));
    expect(await applyStoredRampWebhookEvent(env, stored, 1)).toBe(false);
    let rows = await readInboxRows();
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.last_error).toBeTruthy();

    expect(await applyStoredRampWebhookEvent(env, stored, RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS)).toBe(
      false
    );
    processSpy.mockRestore();
    rows = await readInboxRows();
    expect(rows[0]?.status).toBe("failed");
  });

  it("discards a terminal sandbox failure without alerting", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const stored = await events.insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: completedPayload,
    });
    const processSpy = vi
      .spyOn(RAMP_PROVIDER_WEBHOOK_PROCESSOR.moonpay, "process")
      .mockRejectedValue(new TerminalRampWebhookError("customer was not found or is not active"));
    try {
      expect(await applyStoredRampWebhookEvent(env, stored, 1)).toBe(false);
    } finally {
      processSpy.mockRestore();
    }
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "discarded", attempts: 0 },
    ]);
  });

  it("parks a production event whose apply failed terminally on the first attempt", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const stored = await events.insertEvent({
      provider: "moonpay",
      environment: "production",
      payload: completedPayload,
    });
    const processSpy = vi
      .spyOn(RAMP_PROVIDER_WEBHOOK_PROCESSOR.moonpay, "process")
      .mockRejectedValue(new TerminalRampWebhookError("customer was not found or is not active"));
    try {
      expect(await applyStoredRampWebhookEvent(env, stored, 1)).toBe(false);
    } finally {
      processSpy.mockRestore();
    }
    const rows = await readInboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.attempts).toBe(RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS);
  });

  it("parks a refused production outcome on the first attempt", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const stored = await events.insertEvent({
      provider: "moonpay",
      environment: "production",
      payload: completedPayload,
    });
    const processSpy = vi
      .spyOn(RAMP_PROVIDER_WEBHOOK_PROCESSOR.moonpay, "process")
      .mockResolvedValue({ outcome: "refused", reason: "asset_mismatch" });
    try {
      expect(await applyStoredRampWebhookEvent(env, stored, 1)).toBe(false);
    } finally {
      processSpy.mockRestore();
    }
    expect(await readInboxRows()).toMatchObject([
      {
        status: "failed",
        apply_outcome: "refused",
        attempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
        last_error: "asset_mismatch",
      },
    ]);
  });

  it("parks a production event aimed at a sandbox transfer without binding it", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const { row: stored } = await events.insertVerifiedEvent({
      provider: "moonpay",
      environment: "production",
      rawBody: JSON.stringify(completedPayload),
      providerEventId: null,
    });

    expect(await applyStoredRampWebhookEvent(env, stored, 1)).toBe(false);
    expect(await readInboxRows()).toMatchObject([
      {
        status: "failed",
        apply_outcome: "refused",
        last_error: "environment_mismatch",
        attempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      },
    ]);
    const transfer = await getDb(env)
      .prepare("SELECT status, provider_reference FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_reference: string | null }>();
    expect(transfer).toEqual({ status: "awaiting_payment", provider_reference: null });
  });

  it("parks a production settlement after cancellation with its reason", async () => {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET project_id = ?, status = 'canceled' WHERE id = ?")
      .bind(`${PROJECT_ID}_production`, TRANSFER_ID)
      .run();
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const { row: stored } = await events.insertVerifiedEvent({
      provider: "moonpay",
      environment: "production",
      rawBody: JSON.stringify(completedPayload),
      providerEventId: null,
    });

    expect(await applyStoredRampWebhookEvent(env, stored, 1)).toBe(false);
    expect(await readInboxRows()).toMatchObject([
      {
        status: "failed",
        apply_outcome: "refused",
        last_error: "settled_after_cancel",
        attempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      },
    ]);
    expect(await readTransferStatus()).toBe("canceled");
  });

  /** Inserts a replayable row directly: `insertEvent` only takes a live provider. */
  async function seedStoredEvent(provider: string): Promise<string> {
    const id = `rwe_stored_${provider}`;
    const longAgo = "2026-06-18T00:00:00.000Z";
    await getDb(env)
      .prepare(
        `INSERT INTO ramp_webhook_events (id, provider, environment, payload, created_at, updated_at)
         VALUES (?, ?, 'production', '{}'::jsonb, ?, ?)`
      )
      .bind(id, provider, longAgo, longAgo)
      .run();
    return id;
  }

  it.each(RETIRED_RAMP_PROVIDERS)(
    "parks a retired %s event for want of a processor, without making it terminal",
    async (provider) => {
      const id = await seedStoredEvent(provider);

      expect(await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_STAGES)).toBe(0);

      const row = await getDb(env)
        .prepare("SELECT status, terminal, last_error FROM ramp_webhook_events WHERE id = ?")
        .bind(id)
        .first<{ status: string; terminal: boolean; last_error: string | null }>();
      expect(row).toEqual({
        status: "failed",
        terminal: false,
        last_error: `no webhook processor for provider ${provider}`,
      });
    }
  );

  it("leaves an event from a provider this deployment does not know untouched", async () => {
    const unknown = await seedStoredEvent("not-a-ramp-provider");
    const stored = await createPostgresRampWebhookEventsRepository(getDb(env)).insertEvent({
      provider: "moonpay",
      environment: "sandbox",
      payload: completedPayload,
    });
    await getDb(env)
      .prepare("UPDATE ramp_webhook_events SET created_at = ?, updated_at = ? WHERE id = ?")
      .bind("2026-06-18T00:00:00.000Z", "2026-06-18T00:00:00.000Z", stored.id)
      .run();

    expect(await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_STAGES)).toBe(1);

    expect(await readTransferStatus()).toBe("completed");
    expect(await readInboxRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unknown, status: "pending", attempts: 0, last_error: null }),
        expect.objectContaining({ id: stored.id, status: "discharged" }),
      ])
    );
  });

  describe("with one ramp provider in the release channel and another out", () => {
    // Today every provider is `experimental`, so `beta` would leave them all out:
    // these stages put MoonPay in `beta` and keep Stripe out of it.
    const MOONPAY_ONLY: SdpRampProviderStages = { ...SDP_RAMP_PROVIDER_STAGES, moonpay: "beta" };
    const betaEnv = (): Env => ({ ...env, SDP_RELEASE_CHANNEL: "beta" });
    const betaApp = createApp({
      observability: noopObservability,
      rampProviderStages: MOONPAY_ONLY,
    });

    it("accepts the included provider's webhook and refuses the excluded one's", async () => {
      const { res } = await sendMoonpayWebhook(completedPayload, {
        target: { app: betaApp, env: betaEnv() },
      });
      expect(res.status).toBe(200);
      expect(await readTransferStatus()).toBe("completed");

      const refused = await betaApp.request(
        "/webhooks/payments/ramps/sandbox/stripe",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        betaEnv()
      );
      expect(refused.status).toBe(403);
      expect(await readInboxRows()).toMatchObject([{ status: "discharged" }]);
    });

    it("answers an unknown provider name as before", async () => {
      const res = await betaApp.request(
        "/webhooks/payments/ramps/sandbox/not-a-provider",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        betaEnv()
      );
      expect(res.status).toBe(400);
    });

    it("replays, parks and re-arms only the included provider's rows", async () => {
      const events = createPostgresRampWebhookEventsRepository(getDb(env));
      const included = await events.insertEvent({
        provider: "moonpay",
        environment: "sandbox",
        payload: completedPayload,
      });
      const excludedPending = await events.insertEvent({
        provider: "stripe",
        environment: "sandbox",
        payload: { excluded: "pending" },
      });
      const excludedExhausted = await events.insertEvent({
        provider: "stripe",
        environment: "sandbox",
        payload: { excluded: "exhausted" },
      });
      const excludedParked = await events.insertEvent({
        provider: "stripe",
        environment: "sandbox",
        payload: { excluded: "parked" },
      });
      const longAgo = "2026-06-18T00:00:00.000Z";
      await getDb(env)
        .prepare("UPDATE ramp_webhook_events SET created_at = ?, updated_at = ?")
        .bind(longAgo, longAgo)
        .run();
      await getDb(env)
        .prepare("UPDATE ramp_webhook_events SET attempts = ? WHERE id = ?")
        .bind(RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS, excludedExhausted.id)
        .run();
      await getDb(env)
        .prepare(
          `UPDATE ramp_webhook_events
             SET status = 'failed', attempts = ?, parked_app_revision = 'rev-previous'
           WHERE id = ?`
        )
        .bind(RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS, excludedParked.id)
        .run();

      const applied = await replayRampWebhookEvents(betaEnv(), MOONPAY_ONLY);

      expect(applied).toBe(1);
      expect(await readTransferStatus()).toBe("completed");
      const rows = await getDb(env)
        .prepare("SELECT id, status, attempts, last_error FROM ramp_webhook_events")
        .all<{ id: string; status: string; attempts: number; last_error: string | null }>();
      const byId = new Map(rows.results.map((row) => [row.id, row]));
      expect(byId.get(included.id)).toMatchObject({ status: "discharged" });
      expect(byId.get(excludedPending.id)).toMatchObject({
        status: "pending",
        attempts: 0,
        last_error: null,
      });
      expect(byId.get(excludedExhausted.id)).toMatchObject({
        status: "pending",
        attempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      });
      expect(byId.get(excludedParked.id)).toMatchObject({
        status: "failed",
        attempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      });
    });

    it("touches no row when no ramp provider is in the release channel", async () => {
      const stored = await createPostgresRampWebhookEventsRepository(getDb(env)).insertEvent({
        provider: "moonpay",
        environment: "sandbox",
        payload: completedPayload,
      });
      await getDb(env)
        .prepare("UPDATE ramp_webhook_events SET created_at = ?, updated_at = ? WHERE id = ?")
        .bind("2026-06-18T00:00:00.000Z", "2026-06-18T00:00:00.000Z", stored.id)
        .run();

      expect(
        await replayRampWebhookEvents(
          { ...env, SDP_RELEASE_CHANNEL: "stable" },
          SDP_RAMP_PROVIDER_STAGES
        )
      ).toBe(0);

      expect(await readInboxRows()).toMatchObject([
        { id: stored.id, status: "pending", attempts: 0 },
      ]);
      expect(await readTransferStatus()).toBe("awaiting_payment");
    });
  });
});
