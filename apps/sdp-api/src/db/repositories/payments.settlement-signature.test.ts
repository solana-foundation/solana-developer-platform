import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
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
