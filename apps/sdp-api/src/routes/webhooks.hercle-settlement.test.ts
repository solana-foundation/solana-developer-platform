import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { ParsedTransaction } from "@sdp/rpc/solana";
import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import type { ExecutionContext } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresRampWebhookEventsRepository } from "@/db/repositories/ramp-webhook-event.repository";
import { app } from "@/index";
import {
  applyStoredRampWebhookEvent,
  RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
  replayRampWebhookEvents,
} from "@/services/jobs/replay-ramp-webhook-events";
import { type RampChainReader, verifyRampDeliveries } from "@/services/jobs/verify-ramp-deliveries";
import { env } from "@/test/helpers/env";
import { installHercleTestEnv } from "@/test/helpers/hercle-env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * Evidence for `docs/contributing/ramp-provider-safety.md` with Hercle's own deliveries.
 * Each event is signed with a generated P-256 key and goes through the public webhook route and the inbox.
 * Hercle sends no delivery id and no ordering field, so redeliveries and stale events rely on the status guards.
 * The chain verification cases take the settled event the route stored to the shared delivery verifier.
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
  const OTHER_SIGNATURE =
    "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
  const TRANSFER_CREATED_AT = "2026-11-02T00:00:00.000Z";

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

  async function readTransfer(id = TRANSFER_ID) {
    return getDb(env)
      .prepare("SELECT status, provider_data FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<{ status: string; provider_data: Record<string, unknown> }>();
  }

  /** The columns a quote fixes and a settlement may fill, which no provider report may overwrite. */
  async function readTerms() {
    return getDb(env)
      .prepare(
        `SELECT status, token, destination_address, fiat_currency, fiat_amount, amount, signature, error
         FROM payment_transfers WHERE id = ?`
      )
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        token: string;
        destination_address: string;
        fiat_currency: string;
        fiat_amount: string;
        amount: string | null;
        signature: string | null;
        error: string | null;
      }>();
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

  async function seedOrganization(organizationId: string, projectId: string) {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        organizationId,
        organizationId,
        organizationId.replaceAll("_", "-"),
        "enterprise",
        "active"
      )
      .run();
    await seedDefaultProjects(getDb(env), {
      organizationId,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: projectId, production: `${projectId}_production` },
    });
  }

  /** A Hercle on-ramp as the quote stores it: pending, bound to its order, with no crypto amount quoted. */
  async function insertTransfer(input: {
    id: string;
    organizationId: string;
    projectId: string;
    orderId: string;
  }) {
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
        input.id,
        input.organizationId,
        input.projectId,
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
        input.orderId,
        "manual_instructions",
        "EUR",
        "100.00",
        {},
        null,
        null,
        null,
        TRANSFER_CREATED_AT,
        TRANSFER_CREATED_AT
      )
      .run();
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "hercle-settlement@example.com", 1, "active")
      .run();
    await seedOrganization(ORG_ID, PROJECT_ID);
    await insertTransfer({
      id: TRANSFER_ID,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      orderId: ORDER_ID,
    });
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

  it.each([
    { reported: { status: "awaiting_payment" }, status: "awaiting_payment", error: null },
    { reported: { status: "settling" }, status: "settling", error: null },
    {
      reported: { status: "expired", error: "FUNDING_WINDOW_EXPIRED" },
      status: "expired",
      error: "The order's funding window closed before the wire arrived.",
    },
  ])(
    "moves a pending transfer to $status on Hercle's report",
    async ({ reported, status, error }) => {
      const res = await deliver(settlementBody(reported));

      expect(res.status).toBe(200);
      expect(await readTerms()).toMatchObject({ status, error, signature: null });
      expect(await readInboxRows()).toMatchObject([
        { status: "discharged", apply_outcome: "applied" },
      ]);
    }
  );

  it("ignores an order status SDP does not know, leaving the transfer for the status pull to hold", async () => {
    await deliver(settlementBody({ status: "refunding" }));

    expect((await readTransfer())?.status).toBe("pending");
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "ignored" },
    ]);
  });

  it("waits at settling on a settled report without a transaction, then takes the report naming it", async () => {
    await deliver(settlementBody({ status: "settled" }));
    expect(await readTerms()).toMatchObject({ status: "settling", signature: null });

    await deliver(settlementBody(SETTLED));

    expect(await readTerms()).toMatchObject({ status: "settling", signature: DELIVERY_SIGNATURE });
    expect((await readTransfer())?.provider_data.providerSettlement).toMatchObject({
      onchain: { signature: DELIVERY_SIGNATURE, destinationAddress: DESTINATION },
    });
  });

  it("keeps the delivery Hercle named first when a later report names another transaction", async () => {
    await deliver(settlementBody(SETTLED));
    const first = await readTransfer();

    await deliver(settlementBody({ ...SETTLED, txHash: OTHER_SIGNATURE }));

    expect(await readTransfer()).toEqual(first);
    expect((await readTerms())?.signature).toBe(DELIVERY_SIGNATURE);
  });

  it.each([
    { status: "awaiting_payment" },
    { status: "settling" },
    { status: "failed", error: "SETTLEMENT_FAILED" },
    { status: "expired", error: "FUNDING_WINDOW_EXPIRED" },
  ])(
    "keeps the settled claim when a later report without an ordering field says $status",
    async (late) => {
      await deliver(settlementBody(SETTLED));
      const settled = await readTransfer();

      await deliver(settlementBody(late));

      expect(await readTransfer()).toEqual(settled);
    }
  );

  it("discards a report for an order SDP never quoted, touching no transfer", async () => {
    await deliver(settlementBody({ ...SETTLED, reference: "ord_never_quoted" }));

    expect(await readTransfer()).toMatchObject({ status: "pending", provider_data: {} });
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "discarded", last_error: "provider event unmatched" },
    ]);
  });

  it("moves only the transfer bound to the order, never another tenant's", async () => {
    await seedOrganization("org_hercle_other_tenant", "prj_hercle_other_tenant");
    await insertTransfer({
      id: "xfr_hercle_other_tenant",
      organizationId: "org_hercle_other_tenant",
      projectId: "prj_hercle_other_tenant",
      orderId: "ord_hercle_other_tenant",
    });

    await deliver(settlementBody(SETTLED));

    expect((await readTransfer())?.status).toBe("settling");
    expect(await readTransfer("xfr_hercle_other_tenant")).toMatchObject({
      status: "pending",
      provider_data: {},
    });
  });

  it("replays a stored delivery whose apply never ran, as after a crash between the ack and the apply", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const { row } = await events.insertVerifiedEvent({
      provider: "hercle",
      environment: "sandbox",
      rawBody: settlementBody(SETTLED),
      providerEventId: null,
    });
    await getDb(env)
      .prepare("UPDATE ramp_webhook_events SET created_at = ?, updated_at = ? WHERE id = ?")
      .bind(TRANSFER_CREATED_AT, TRANSFER_CREATED_AT, row.id)
      .run();

    expect(await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_MATURITY)).toBe(1);
    expect((await readTransfer())?.status).toBe("settling");
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "applied" },
    ]);
  });

  describe("chain verification", () => {
    const getTransaction = vi.fn<RampChainReader["getTransaction"]>();
    const getSignatureStatuses = vi.fn<RampChainReader["getSignatureStatuses"]>();
    const chain: RampChainReader = { getTransaction, getSignatureStatuses };
    /** Five minutes after the transfer was created, so the delivery never predates it. */
    const LANDED_AT = BigInt(Date.parse(TRANSFER_CREATED_AT) / 1000 + 300);
    const DELIVERED_BASE_UNITS = "99020000";

    beforeEach(() => {
      getTransaction.mockReset();
      getSignatureStatuses.mockReset();
    });

    function verifySweep() {
      return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        verifyRampDeliveries(env, chain)
      );
    }

    /** A finalized transaction that moved `baseUnits` of `mint`, at six decimals, to `owner`. */
    function landed(
      baseUnits = DELIVERED_BASE_UNITS,
      owner = DESTINATION,
      mint = usdcMint()
    ): ParsedTransaction {
      return {
        slot: 42n,
        blockTime: LANDED_AT,
        accountKeys: ["hercle-delivery-signer"],
        executionResultKnown: true,
        err: null,
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 0, mint, owner, amount: baseUnits, decimals: 6 }],
        instructions: [],
      };
    }

    it("completes a settled order only from the chain, with one transaction read, keeping the quoted terms", async () => {
      await deliver(settlementBody(SETTLED));
      getTransaction.mockResolvedValue(landed());

      await verifySweep();

      expect(getTransaction).toHaveBeenCalledExactlyOnceWith(DELIVERY_SIGNATURE);
      expect(getSignatureStatuses).not.toHaveBeenCalled();
      // Neither Hercle nor the quote names a crypto amount, so the amount is the one the chain shows.
      expect(await readTerms()).toMatchObject({
        status: "completed",
        token: usdcMint(),
        destination_address: DESTINATION,
        fiat_currency: "EUR",
        fiat_amount: "100.00",
        amount: "99.02",
        signature: DELIVERY_SIGNATURE,
      });
      expect((await readTransfer())?.provider_data.verifiedDelivery).toMatchObject({
        signature: DELIVERY_SIGNATURE,
        destinationAddress: DESTINATION,
        amount: "99.02",
      });
    });

    const contradicted: [string, () => ParsedTransaction, string][] = [
      ["to another wallet", () => landed(DELIVERED_BASE_UNITS, "attacker-wallet"), "not_delivered"],
      [
        "of another mint",
        () => landed(DELIVERED_BASE_UNITS, DESTINATION, "wrong-mint"),
        "not_delivered",
      ],
      [
        "that failed",
        () => ({ ...landed(), err: { InstructionError: [0, "Custom"] } }),
        "transaction_failed",
      ],
      [
        "that landed before the order",
        () => ({ ...landed(), blockTime: BigInt(Date.parse("2026-10-01T00:00:00.000Z") / 1000) }),
        "predates_transfer",
      ],
    ];

    it.each(contradicted)(
      "holds a delivery %s and stops re-reading it",
      async (_case, transaction, reason) => {
        await deliver(settlementBody(SETTLED));
        getTransaction.mockResolvedValue(transaction());

        await verifySweep();
        await verifySweep();

        expect(getTransaction).toHaveBeenCalledTimes(1);
        expect(await readTerms()).toMatchObject({ status: "settling", amount: null });
        expect((await readTransfer())?.provider_data.deliveryMismatch).toMatchObject({ reason });
      }
    );

    it.each([
      ["is not finalized yet", () => getTransaction.mockResolvedValueOnce(null)],
      [
        "has no known execution result",
        () => getTransaction.mockResolvedValueOnce({ ...landed(), executionResultKnown: false }),
      ],
      [
        "cannot be read while the RPC is down",
        () => getTransaction.mockRejectedValueOnce(new TypeError("fetch failed")),
      ],
    ])(
      "keeps a delivery that %s at settling and completes it once it reads",
      async (_case, firstRead) => {
        await deliver(settlementBody(SETTLED));
        firstRead();

        await verifySweep();
        expect(await readTerms()).toMatchObject({ status: "settling", amount: null });
        expect((await readTransfer())?.provider_data).not.toHaveProperty("deliveryMismatch.reason");

        getTransaction.mockResolvedValueOnce(landed());
        await verifySweep();

        expect(getTransaction).toHaveBeenCalledTimes(2);
        expect((await readTerms())?.status).toBe("completed");
      }
    );

    it("never reads the chain when Hercle names another destination, and holds the report", async () => {
      await deliver(settlementBody({ ...SETTLED, destinationWalletAddress: "attacker-wallet" }));

      await verifySweep();
      await verifySweep();

      expect(getTransaction).not.toHaveBeenCalled();
      expect(await readTerms()).toMatchObject({
        status: "settling",
        destination_address: DESTINATION,
      });
      expect((await readTransfer())?.provider_data.deliveryMismatch).toMatchObject({
        reason: "provider_report_mismatch",
      });
    });

    it("completes from the chain after Hercle contradicts its settled report without an ordering field", async () => {
      await deliver(settlementBody(SETTLED));
      await deliver(settlementBody({ status: "failed", error: "SETTLEMENT_FAILED" }));
      getTransaction.mockResolvedValue(landed());

      await verifySweep();

      expect(getTransaction).toHaveBeenCalledExactlyOnceWith(DELIVERY_SIGNATURE);
      expect((await readTerms())?.status).toBe("completed");
    });

    it("does not complete when the stored settlement changes during the chain read", async () => {
      await deliver(settlementBody(SETTLED));
      getTransaction.mockImplementation(async () => {
        await getDb(env)
          .prepare(
            `UPDATE payment_transfers
             SET provider_data = jsonb_set(provider_data, '{providerSettlement,reference}', '"ord_changed"'::jsonb)
             WHERE id = ?`
          )
          .bind(TRANSFER_ID)
          .run();
        return landed();
      });

      await verifySweep();

      expect(await readTerms()).toMatchObject({ status: "settling", amount: null });
    });

    it("changes nothing when Hercle redelivers or contradicts a completed order", async () => {
      await deliver(settlementBody(SETTLED));
      getTransaction.mockResolvedValue(landed());
      await verifySweep();
      const completed = await readTransfer();
      expect(completed?.status).toBe("completed");

      await deliver(settlementBody(SETTLED));
      await deliver(settlementBody({ status: "failed", error: "SETTLEMENT_FAILED" }));
      await verifySweep();

      expect(await readTransfer()).toEqual(completed);
      expect(getTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
