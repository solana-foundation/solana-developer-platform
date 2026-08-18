import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  CreateWithdrawalInput,
  PrivateChannelWithdrawalRepository,
} from "./private-channel-withdrawal.repository";
import { createPostgresPrivateChannelWithdrawalRepository } from "./private-channel-withdrawal.repository.postgres";

const TEST_PROJECT_ID = "prj_pcw_repo_test";
const TEST_INSTANCE_ID = "inst_pcw_1";

function makeInput(overrides: Partial<CreateWithdrawalInput> = {}): CreateWithdrawalInput {
  return {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    instanceId: TEST_INSTANCE_ID,
    walletId: "wal_pcw_1",
    owner: "OwnerAddr1111111111111111111111111111111111",
    destination: "DestAddr11111111111111111111111111111111111",
    mint: "MintAddr11111111111111111111111111111111111",
    amount: "1.5",
    context: {
      gatewayUrl: "https://gw.example",
      chainRpcUrl: "https://devnet.example",
      escrowProgramId: "EscrowProg1111111111111111111111111111111",
      escrowInstanceAddr: "EscrowInst1111111111111111111111111111111",
      actingUserId: TEST_USER.id,
    },
    ...overrides,
  };
}

describe("PrivateChannelWithdrawalRepository (postgres)", () => {
  let repo: PrivateChannelWithdrawalRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM private_channel_withdrawals").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();

    repo = createPostgresPrivateChannelWithdrawalRepository(db);
  });

  async function seed(overrides: Partial<CreateWithdrawalInput> = {}) {
    const row = await repo.createWithdrawal(makeInput(overrides));
    if (!row) {
      throw new Error("test setup: createWithdrawal returned null");
    }
    return row;
  }

  it("createWithdrawal defaults to pending and round-trips the context", async () => {
    const row = await repo.createWithdrawal(makeInput());

    expect(row).not.toBeNull();
    expect(row?.id).toMatch(/^wd_/);
    expect(row?.status).toBe("pending");
    expect(row?.signature).toBeNull();
    expect(row?.settlement_ref).toBeNull();
    expect(row?.context).toMatchObject({
      gatewayUrl: "https://gw.example",
      chainRpcUrl: "https://devnet.example",
    });
  });

  it("updateWithdrawal applies the CAS transition when expectedStatus matches", async () => {
    const created = await seed();
    const updated = await repo.updateWithdrawal({
      id: created.id,
      status: "submitted",
      signature: "burnSig1",
      expectedStatus: "pending",
    });

    expect(updated?.status).toBe("submitted");
    expect(updated?.signature).toBe("burnSig1");
  });

  it("updateWithdrawal is a no-op (null) when expectedStatus does not match", async () => {
    const created = await seed();
    const updated = await repo.updateWithdrawal({
      id: created.id,
      status: "settled",
      expectedStatus: "confirmed",
    });

    expect(updated).toBeNull();
    const reread = await repo.getWithdrawalById({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      id: created.id,
    });
    expect(reread?.status).toBe("pending");
  });

  it("updateWithdrawal COALESCEs: later transitions keep the burn signature", async () => {
    const created = await seed();
    await repo.updateWithdrawal({
      id: created.id,
      status: "submitted",
      signature: "burnSig2",
      expectedStatus: "pending",
    });
    await repo.updateWithdrawal({
      id: created.id,
      status: "confirmed",
      expectedStatus: "submitted",
    });
    const settled = await repo.updateWithdrawal({
      id: created.id,
      status: "settled",
      settlementRef: "releaseSig2",
      expectedStatus: "confirmed",
    });

    expect(settled?.status).toBe("settled");
    expect(settled?.signature).toBe("burnSig2");
    expect(settled?.settlement_ref).toBe("releaseSig2");
  });

  it("listNonTerminal returns non-terminal rows only, oldest updated first, bounded by limit", async () => {
    const a = await seed();
    const b = await seed();
    // Move b to a terminal state.
    await repo.updateWithdrawal({ id: b.id, status: "submitted", expectedStatus: "pending" });
    await repo.updateWithdrawal({
      id: b.id,
      status: "confirmed",
      expectedStatus: "submitted",
    });
    await repo.updateWithdrawal({
      id: b.id,
      status: "settled",
      settlementRef: "rel",
      expectedStatus: "confirmed",
    });

    const nonTerminal = await repo.listNonTerminal(10);
    expect(nonTerminal.map((r) => r.id)).toEqual([a.id]);
  });

  it("patchContext merges into the JSONB atomically", async () => {
    const created = await seed();
    await repo.patchContext(created.id, { lastStuckWarningAt: "2026-07-27T00:00:00.000Z" });

    const reread = await repo.getWithdrawalById({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      id: created.id,
    });
    expect(reread?.context.lastStuckWarningAt).toBe("2026-07-27T00:00:00.000Z");
    expect(reread?.context.gatewayUrl).toBe("https://gw.example");
  });

  it("countNonTerminalByInstance counts only in-flight rows for the instance", async () => {
    const inFlight = await repo.createWithdrawal(makeInput({ instanceId: "inst_A" }));
    const other = await seed({ instanceId: "inst_A" });
    await repo.createWithdrawal(makeInput({ instanceId: "inst_B" }));
    // Drive one to terminal.
    await repo.updateWithdrawal({ id: other.id, status: "submitted", expectedStatus: "pending" });
    await repo.updateWithdrawal({
      id: other.id,
      status: "confirmed",
      expectedStatus: "submitted",
    });
    await repo.updateWithdrawal({
      id: other.id,
      status: "settled",
      settlementRef: "rel",
      expectedStatus: "confirmed",
    });

    expect(await repo.countNonTerminalByInstance("inst_A")).toBe(1);
    expect(await repo.countNonTerminalByInstance("inst_B")).toBe(1);
    void inFlight;
  });
});
