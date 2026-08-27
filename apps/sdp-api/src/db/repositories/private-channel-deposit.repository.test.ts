import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  CreateDepositInput,
  PrivateChannelDepositRepository,
} from "./private-channel-deposit.repository";
import { createPostgresPrivateChannelDepositRepository } from "./private-channel-deposit.repository.postgres";

const TEST_PROJECT_ID = "prj_pcd_repo_test";
const TEST_INSTANCE_ID = "inst_pcd_1";
const RECIPIENT = "RecipientAddr11111111111111111111111111111";
const MINT = "MintAddr11111111111111111111111111111111111";

function makeInput(overrides: Partial<CreateDepositInput> = {}): CreateDepositInput {
  return {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    instanceId: TEST_INSTANCE_ID,
    walletId: "wal_pcd_1",
    depositor: "DepositorAddr1111111111111111111111111111",
    recipient: RECIPIENT,
    mint: MINT,
    amount: "1.5",
    context: {
      gatewayUrl: "https://gw.example",
      escrowProgramId: "EscrowProg1111111111111111111111111111111",
      escrowInstanceAddr: "EscrowInst1111111111111111111111111111111",
      actingUserId: TEST_USER.id,
    },
    ...overrides,
  };
}

describe("PrivateChannelDepositRepository (postgres)", () => {
  let repo: PrivateChannelDepositRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM private_channel_deposits").run();
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

    repo = createPostgresPrivateChannelDepositRepository(db);
  });

  it("createDeposit persists every column and defaults to pending", async () => {
    const row = await repo.createDeposit(makeInput());

    expect(row).not.toBeNull();
    expect(row?.id).toMatch(/^dep_/);
    expect(row?.status).toBe("pending");
    expect(row?.signature).toBeNull();
    expect(row?.settlement_ref).toBeNull();
    expect(row?.recipient).toBe(RECIPIENT);
    expect(row?.amount).toBe("1.5");
    // Context is opaque JSONB round-tripped as-is; the oracle never reads it.
    expect(row?.context).toMatchObject({
      gatewayUrl: "https://gw.example",
      escrowProgramId: "EscrowProg1111111111111111111111111111111",
      escrowInstanceAddr: "EscrowInst1111111111111111111111111111111",
    });
  });

  it("updateDeposit is a compare-and-swap when expectedStatus is set", async () => {
    const created = await repo.createDeposit(makeInput());
    expect(created).not.toBeNull();
    const id = created?.id ?? "";

    // Wrong expected status → no-op.
    const noop = await repo.updateDeposit({
      id,
      status: "confirmed",
      expectedStatus: "submitted",
    });
    expect(noop).toBeNull();

    // Correct expected status → advances.
    const advanced = await repo.updateDeposit({
      id,
      status: "submitted",
      signature: "sigX",
      expectedStatus: "pending",
    });
    expect(advanced?.status).toBe("submitted");
    expect(advanced?.signature).toBe("sigX");

    // A second submitted → pending CAS is a no-op now that the row moved on.
    const noopAgain = await repo.updateDeposit({
      id,
      status: "confirmed",
      expectedStatus: "pending",
    });
    expect(noopAgain).toBeNull();
  });

  it("listNonTerminal returns non-terminal rows only, oldest updated first", async () => {
    const pending = await repo.createDeposit(makeInput());
    const other = await repo.createDeposit(makeInput());
    expect(pending && other).toBeTruthy();
    // Move `other` to terminal so it's excluded.
    await repo.updateDeposit({
      id: other?.id ?? "",
      status: "failed",
      failureReason: "oops",
      expectedStatus: "pending",
    });

    const rows = await repo.listNonTerminal(10);
    expect(rows.map((r) => r.id)).toEqual([pending?.id ?? ""]);
  });

  it("patchContext merges into the JSONB atomically without touching other fields", async () => {
    const created = await repo.createDeposit(makeInput());
    const id = created?.id ?? "";

    await repo.patchContext(id, { lastStuckWarningAt: "2026-07-27T00:00:00.000Z" });

    const reloaded = await repo.getDepositById({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      id,
    });
    expect(reloaded?.context.lastStuckWarningAt).toBe("2026-07-27T00:00:00.000Z");
    // Original keys survive the merge.
    expect(reloaded?.context.gatewayUrl).toBe("https://gw.example");
  });

  it("countNonTerminalByInstance ignores terminal deposits", async () => {
    const created = await repo.createDeposit(makeInput());
    expect(await repo.countNonTerminalByInstance(TEST_INSTANCE_ID)).toBe(1);
    await repo.updateDeposit({
      id: created?.id ?? "",
      status: "failed",
      failureReason: "x",
      expectedStatus: "pending",
    });
    expect(await repo.countNonTerminalByInstance(TEST_INSTANCE_ID)).toBe(0);
  });
});
