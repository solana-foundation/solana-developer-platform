import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type {
  ClaimSettlementInput,
  PrivateChannelSettlementObservationRepository,
} from "./private-channel-settlement-observation.repository";
import { createPostgresPrivateChannelSettlementObservationRepository } from "./private-channel-settlement-observation.repository.postgres";

function makeInput(overrides: Partial<ClaimSettlementInput> = {}): ClaimSettlementInput {
  return {
    signature: "relSig1",
    instructionIndex: 0,
    intentKind: "withdrawal",
    intentId: "wd_1",
    destination: "DestAta11111111111111111111111111111111111",
    mint: "MintAddr1111111111111111111111111111111111",
    amount: "10",
    blockTime: 1_700_000_000,
    ...overrides,
  };
}

describe("PrivateChannelSettlementObservationRepository (postgres)", () => {
  let repo: PrivateChannelSettlementObservationRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM private_channel_settlement_observations").run();
    repo = createPostgresPrivateChannelSettlementObservationRepository(db);
  });

  it("claimSettlement inserts and returns the winning row", async () => {
    const row = await repo.claimSettlement(makeInput());
    expect(row).not.toBeNull();
    expect(row?.signature).toBe("relSig1");
    expect(row?.intent_id).toBe("wd_1");
    expect(row?.block_time).toBe(1_700_000_000);
  });

  it("claimSettlement returns null on a duplicate (source, signature, instructionIndex)", async () => {
    await repo.claimSettlement(makeInput());
    // Second poller tries to claim the same on-chain observation for a different intent.
    const dup = await repo.claimSettlement(makeInput({ intentId: "wd_2" }));
    expect(dup).toBeNull();
  });

  it("claimSettlement returns null when the intent is already settled (UNIQUE intent_kind, intent_id)", async () => {
    await repo.claimSettlement(makeInput());
    // Same intent, different observation (retry) → still blocked.
    const dup = await repo.claimSettlement(
      makeInput({ signature: "relSigOther", instructionIndex: 1 })
    );
    expect(dup).toBeNull();
  });

  it("findByIntent returns the winning observation for the intent", async () => {
    await repo.claimSettlement(makeInput({ signature: "relSigWinner" }));
    const found = await repo.findByIntent("withdrawal", "wd_1");
    expect(found?.signature).toBe("relSigWinner");
  });
});
