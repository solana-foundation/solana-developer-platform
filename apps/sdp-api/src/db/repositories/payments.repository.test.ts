import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { PaymentsRepository } from "./payments.repository";
import { createPostgresPaymentsRepository } from "./payments.repository.postgres";

const TEST_PROJECT_ID = "prj_payments_repo_test";
const OTHER_PROJECT_ID = "prj_payments_repo_test_other";
const TEST_WALLET_ID = "wallet_payments_repo_test";
const CANCELABLE = ["pending", "awaiting_payment"] as const;

describe("PaymentsRepository.updateTransferStatusGuarded (postgres)", () => {
  let repo: PaymentsRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_transfers").run();
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
    for (const projectId of [TEST_PROJECT_ID, OTHER_PROJECT_ID]) {
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, TEST_ORG.id, projectId, TEST_USER.id)
        .run();
    }

    repo = createPostgresPaymentsRepository(db);
  });

  async function seedTransfer(input: {
    id: string;
    status: string;
    projectId?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, token, type, direction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        TEST_ORG.id,
        input.projectId ?? TEST_PROJECT_ID,
        TEST_WALLET_ID,
        "USDC",
        "offramp",
        "outbound",
        input.status,
        now,
        now
      )
      .run();
  }

  async function readStatus(id: string): Promise<string | null> {
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    return row?.status ?? null;
  }

  it("transitions the status when the current status is in fromStatuses", async () => {
    await seedTransfer({ id: "xfr_guard_ok", status: "awaiting_payment" });

    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_guard_ok",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated?.status).toBe("canceled");
    expect(await readStatus("xfr_guard_ok")).toBe("canceled");
  });

  it("is a no-op returning null when the status moved out of fromStatuses (the race)", async () => {
    await seedTransfer({ id: "xfr_guard_race", status: "settling" });

    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_guard_race",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
    expect(await readStatus("xfr_guard_race")).toBe("settling");
  });

  it("returns null for a transfer that does not exist", async () => {
    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_missing",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
  });

  it("does not transition a transfer owned by a different organization", async () => {
    await seedTransfer({ id: "xfr_guard_org", status: "awaiting_payment" });

    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_guard_org",
      organizationId: "org_someone_else",
      projectId: TEST_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
    expect(await readStatus("xfr_guard_org")).toBe("awaiting_payment");
  });

  it("does not transition a transfer scoped to a different project", async () => {
    await seedTransfer({ id: "xfr_guard_project", status: "awaiting_payment" });

    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_guard_project",
      organizationId: TEST_ORG.id,
      projectId: OTHER_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
    expect(await readStatus("xfr_guard_project")).toBe("awaiting_payment");
  });
});
