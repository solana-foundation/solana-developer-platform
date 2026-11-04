import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import type { ExecutionContext } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresRampWebhookEventsRepository } from "@/db/repositories/ramp-webhook-event.repository";
import { app } from "@/index";
import {
  applyStoredRampWebhookEvent,
  RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
} from "@/services/jobs/replay-ramp-webhook-events";
import { env } from "@/test/helpers/env";
import { installHercleTestEnv } from "@/test/helpers/hercle-env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * Evidence for `docs/contributing/ramp-provider-safety.md` with Hercle's own deliveries.
 * Each event is signed with a generated P-256 key and goes through the public webhook route and the inbox.
 * Hercle sends no delivery id and no ordering field, so redeliveries and stale events rely on the status guards.
 */
describe("Hercle settlement webhooks", () => {
  const ORG_ID = "org_hercle_settlement";
  const PROJECT_ID = "prj_hercle_settlement";
  const USER_ID = "usr_hercle_settlement";
  const TRANSFER_ID = "xfr_hercle_settlement";
  const ORDER_ID = "ord_hercle_settlement";
  const DESTINATION = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";
  const DELIVERY_SIGNATURE =
    "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const PUBLIC_KEY_PEM = publicKey.export({ format: "pem", type: "spki" }).toString();

  installHercleTestEnv({ HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY: PUBLIC_KEY_PEM });

  function usdcMint(): string {
    const mint = wellKnownMint("USDC", "devnet");
    if (mint === undefined) {
      throw new Error("USDC has no devnet mint in the catalogue");
    }
    return mint;
  }

  function signed(rawBody: string, key: KeyObject = privateKey) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createSign("SHA256").update(`${timestamp}.${rawBody}`).sign(key, "base64");
    return { "X-Timestamp": String(timestamp), "X-Signature": signature };
  }

  function settlementBody(data: Record<string, unknown>): string {
    return JSON.stringify({
      event: "ramp.settlement.status_changed",
      timestamp: Math.floor(Date.now() / 1000),
      data: { reference: ORDER_ID, ...data },
    });
  }

  async function deliver(rawBody: string) {
    const background: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/hercle",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...signed(rawBody) },
        body: rawBody,
      },
      env,
      executionCtx
    );
    await Promise.allSettled(background);
    return res;
  }

  async function readTransfer() {
    return getDb(env)
      .prepare("SELECT status, provider_data FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; provider_data: Record<string, unknown> }>();
  }

  async function readInboxRows() {
    const result = await getDb(env)
      .prepare(
        "SELECT status, apply_outcome, last_error FROM ramp_webhook_events WHERE provider = 'hercle' ORDER BY created_at"
      )
      .all<{ status: string; apply_outcome: string | null; last_error: string | null }>();
    return result.results;
  }

  async function setTransferStatus(status: string) {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET status = ? WHERE id = ?")
      .bind(status, TRANSFER_ID)
      .run();
  }

  const SETTLED = {
    status: "settled",
    txHash: DELIVERY_SIGNATURE,
    destinationWalletAddress: DESTINATION,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_ID, "Hercle Settlement Org", "hercle-settlement-org", "enterprise", "active")
      .run();
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "hercle-settlement@example.com", 1, "active")
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
        "wallet_hercle_settlement",
        null,
        null,
        DESTINATION,
        usdcMint(),
        null,
        null,
        "onramp",
        "inbound",
        "pending",
        "hercle",
        ORDER_ID,
        "manual_instructions",
        "EUR",
        "100.00",
        {},
        null,
        null,
        null,
        "2026-11-02T00:00:00.000Z",
        "2026-11-02T00:00:00.000Z"
      )
      .run();
  });

  it("moves a settled order to settling, never to completed, from the quote's pending", async () => {
    const res = await deliver(settlementBody(SETTLED));

    expect(res.status).toBe(200);
    expect((await readTransfer())?.status).toBe("settling");
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "applied" },
    ]);
  });

  it("takes a redelivered settlement, which has no delivery id, without changing the transfer", async () => {
    await deliver(settlementBody(SETTLED));
    const first = await readTransfer();

    await deliver(settlementBody(SETTLED));

    expect(await readTransfer()).toEqual(first);
    const rows = await readInboxRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "discharged")).toBe(true);
  });

  it("never moves a settling transfer back on a stale awaiting-payment event", async () => {
    await deliver(settlementBody(SETTLED));

    await deliver(settlementBody({ status: "awaiting_payment" }));

    expect((await readTransfer())?.status).toBe("settling");
  });

  it("never reopens a canceled transfer on a late settlement", async () => {
    await setTransferStatus("canceled");

    await deliver(settlementBody(SETTLED));

    expect((await readTransfer())?.status).toBe("canceled");
  });

  it("fails the transfer with SDP's words for Hercle's reason", async () => {
    await deliver(settlementBody({ status: "failed", error: "THIRD_PARTY_PAYER" }));

    const transfer = await readTransfer();
    expect(transfer?.status).toBe("failed");
    expect(JSON.stringify(transfer)).not.toContain("THIRD_PARTY_PAYER");
  });

  it("refuses a production delivery aimed at a sandbox transfer", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const { row } = await events.insertVerifiedEvent({
      provider: "hercle",
      environment: "production",
      rawBody: settlementBody(SETTLED),
      providerEventId: null,
    });

    expect(await applyStoredRampWebhookEvent(env, row, 1)).toBe(false);
    expect(await readInboxRows()).toMatchObject([
      {
        status: "failed",
        apply_outcome: "refused",
        last_error: "environment_mismatch",
      },
    ]);
    expect((await readTransfer())?.status).toBe("pending");
    expect(RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  it("rejects a delivery signed with another key and leaves the transfer alone", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const rawBody = settlementBody(SETTLED);

    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/hercle",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...signed(rawBody, other) },
        body: rawBody,
      },
      env
    );

    expect(res.status).toBe(401);
    expect(await readInboxRows()).toHaveLength(0);
    expect((await readTransfer())?.status).toBe("pending");
  });
});
