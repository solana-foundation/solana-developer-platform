import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createSystemPaymentsRepository } from "@/db/repositories";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * Pins the two halves of the settlement_signature decision in migration 0068 (#559).
 *
 * They pull in opposite directions and both matter, so neither can be inferred from the other:
 * the column must tolerate the value a linked crypto leg already holds, while refusing to let
 * two ramp transfers claim the same on-chain settlement.
 */
describe("settlement_signature constraints", () => {
  const ORG_ID = "org_settlement_sig_001";

  async function insert(params: {
    id: string;
    type: "onramp" | "offramp" | "transfer";
    signature?: string | null;
    settlementSignature?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
         (id, organization_id, wallet_id, source_address, destination_address,
          token, amount, type, direction, status, signature, settlement_signature,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.id,
        ORG_ID,
        "wal_settlement_sig",
        "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
        "9dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
        "USDC",
        "1.0",
        params.type,
        "outbound",
        "completed",
        params.signature ?? null,
        params.settlementSignature ?? null,
        now,
        now
      )
      .run();
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_ID, "Settlement Sig Org", "settlement-sig-org", "individual", "active")
      .run();
  });

  it("lets a ramp row carry the same signature its linked crypto leg already holds", async () => {
    const shared = "sig_shared_with_crypto_leg";
    // The wallet transfer owns it in `signature`, which IS globally unique.
    await insert({ id: "xfr_leg", type: "transfer", signature: shared });
    // The off-ramp references the same settlement in the separate, non-unique column. Making
    // settlement_signature globally unique would break exactly this, which is the whole reason
    // MoneyGram previously had to hide the value inside provider_data.
    await expect(
      insert({ id: "xfr_ramp", type: "offramp", settlementSignature: shared })
    ).resolves.toBeUndefined();
  });

  it("refuses to let two ramp transfers claim the same on-chain settlement", async () => {
    const shared = "sig_claimed_twice";
    await insert({ id: "xfr_ramp_first", type: "offramp", settlementSignature: shared });
    // Without this guard one real settlement would verify any number of transfers.
    await expect(
      insert({ id: "xfr_ramp_second", type: "onramp", settlementSignature: shared })
    ).rejects.toThrow();
  });
});

/**
 * The verification queue claims rows rather than merely selecting them (#559). Without a claim, two
 * replicas both verify the same row and burn its ten-attempt allowance at double rate, which ends
 * with a real settlement reported unverified.
 */
describe("verification queue claims", () => {
  const ORG_ID = "org_queue_claim_001";

  async function seedQueueRow(id: string, attempts = 0): Promise<void> {
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
         (id, organization_id, wallet_id, source_address, destination_address, token, amount,
          type, direction, status, settlement_signature, verification_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        ORG_ID,
        "wal_queue_claim",
        "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
        "9dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
        "USDC",
        "1.0",
        "onramp",
        "inbound",
        "completed",
        `sig_${id}`,
        attempts,
        now,
        now
      )
      .run();
  }

  function repo() {
    return createSystemPaymentsRepository(env);
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_ID, "Queue Claim Org", "queue-claim-org", "individual", "active")
      .run();
  });

  it("hands disjoint rows to concurrent claims", async () => {
    // The actual P2 guarantee. FOR UPDATE SKIP LOCKED means a second claim racing the first skips
    // the locked rows rather than blocking on them or re-reading them.
    await seedQueueRow("xfr_q1");
    await seedQueueRow("xfr_q2");
    await seedQueueRow("xfr_q3");
    await seedQueueRow("xfr_q4");

    const claimedAt = new Date().toISOString();
    const [first, second] = await Promise.all([
      repo().claimRampTransfersToVerify({ maxAttempts: 10, limit: 2, claimedAt }),
      repo().claimRampTransfersToVerify({ maxAttempts: 10, limit: 2, claimedAt }),
    ]);

    const ids = [...first, ...second].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rotates a claimed row to the back rather than removing it from the queue", async () => {
    // A claim is not a lease. A row whose worker died comes round again, which is what makes the
    // attempt counter (consumed by work, not by claiming) the thing that eventually stops it.
    await seedQueueRow("xfr_q_rotate_a");
    await seedQueueRow("xfr_q_rotate_b");

    const first = await repo().claimRampTransfersToVerify({
      maxAttempts: 10,
      limit: 1,
      claimedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const second = await repo().claimRampTransfersToVerify({
      maxAttempts: 10,
      limit: 1,
      claimedAt: new Date().toISOString(),
    });

    // The never-polled row sorts ahead of the one just stamped, so the second claim gets the other.
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });

  it("stamps the polling cursor but does NOT consume an attempt", async () => {
    // Pinned deliberately: a worker that dies between claim and completion must not burn an
    // attempt having done nothing. Attempts are consumed by work, not by intent.
    await seedQueueRow("xfr_q_attempt");

    await repo().claimRampTransfersToVerify({
      maxAttempts: 10,
      limit: 5,
      claimedAt: new Date().toISOString(),
    });

    const row = await getDb(env)
      .prepare(
        "SELECT verification_attempts, verification_last_polled_at FROM payment_transfers WHERE id = ?"
      )
      .bind("xfr_q_attempt")
      .first<{ verification_attempts: number; verification_last_polled_at: string | null }>();

    expect(row?.verification_attempts).toBe(0);
    expect(row?.verification_last_polled_at).not.toBeNull();
  });

  it("does not claim rows at or above the attempt cap", async () => {
    await seedQueueRow("xfr_q_capped", 10);
    const claimed = await repo().claimRampTransfersToVerify({
      maxAttempts: 10,
      limit: 5,
      claimedAt: new Date().toISOString(),
    });
    expect(claimed.map((r) => r.id)).not.toContain("xfr_q_capped");
  });

  it("does not claim rows that are already verified", async () => {
    await seedQueueRow("xfr_q_done");
    await repo().advanceRampVerification({
      transferId: "xfr_q_done",
      polledAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      slot: 1,
      method: "provider_signature",
    });

    const claimed = await repo().claimRampTransfersToVerify({
      maxAttempts: 10,
      limit: 5,
      claimedAt: new Date().toISOString(),
    });
    expect(claimed.map((r) => r.id)).not.toContain("xfr_q_done");
  });

  it("records the verification method alongside the proof", async () => {
    await seedQueueRow("xfr_q_method");
    await repo().advanceRampVerification({
      transferId: "xfr_q_method",
      polledAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      slot: 7,
      method: "provider_signature",
    });

    const row = await getDb(env)
      .prepare("SELECT settlement_verification_method FROM payment_transfers WHERE id = ?")
      .bind("xfr_q_method")
      .first<{ settlement_verification_method: string | null }>();

    expect(row?.settlement_verification_method).toBe("provider_signature");
  });
});
