import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { createPostgresPrivateChannelInstanceRepository } from "./private-channel-instance.repository.postgres";
import type { PrivateChannelUserRepository } from "./private-channel-user.repository";
import { createPostgresPrivateChannelUserRepository } from "./private-channel-user.repository.postgres";
import { createPostgresPrivateChannelVerifiedWalletRepository } from "./private-channel-verified-wallet.repository.postgres";

const TEST_PROJECT_ID = "prj_pcu_repo_test";
const PCU_ID = "pcu_pcu_repo_test";
const PROJECT_MEMBER_ID = "pm_pcu_repo_test";
const PUBKEY_A = "So11111111111111111111111111111111111111112";
const PUBKEY_B = "So11111111111111111111111111111111111111113";

// verified_wallet_count is a derived read; it must reflect only the project's
// ACTIVE instance so a stale/deactivated instance's verifications don't leak in.
describe("PrivateChannelUserRepository (postgres) — verified_wallet_count", () => {
  let repo: PrivateChannelUserRepository;
  let instanceRepo: ReturnType<typeof createPostgresPrivateChannelInstanceRepository>;
  let walletRepo: ReturnType<typeof createPostgresPrivateChannelVerifiedWalletRepository>;

  const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM private_channel_verified_wallets").run();
    await db.prepare("DELETE FROM private_channel_users").run();
    await db.prepare("DELETE FROM private_channel_instances").run();
    await db.prepare("DELETE FROM project_members").run();
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
    await db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, 'developer')`
      )
      .bind(PROJECT_MEMBER_ID, TEST_PROJECT_ID, TEST_USER.id)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channel_users (id, organization_id, project_id, user_id)
           VALUES (?, ?, ?, ?)`
      )
      .bind(PCU_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();

    instanceRepo = createPostgresPrivateChannelInstanceRepository(db);
    walletRepo = createPostgresPrivateChannelVerifiedWalletRepository(db);
    repo = createPostgresPrivateChannelUserRepository(db);
  });

  // A gateway_url is unique per project, so a second instance needs its own.
  async function connectInstance(gatewayUrl?: string): Promise<string> {
    const created = await instanceRepo.createActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
      ...(gatewayUrl ? { gatewayUrl } : {}),
    });
    if (!created) throw new Error("createActive returned null");
    return created.id;
  }

  it("counts the member's wallets verified under the active instance", async () => {
    const instanceA = await connectInstance();
    await walletRepo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });
    await walletRepo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_2",
      pubkey: PUBKEY_B,
    });

    const [listed] = await repo.listByProject(scope);
    expect(listed.verified_wallet_count).toBe(2);
    const fetched = await repo.getByProjectAndUser(scope, TEST_USER.id);
    expect(fetched?.verified_wallet_count).toBe(2);
  });

  it("excludes verifications made under a since-deactivated instance", async () => {
    const instanceA = await connectInstance();
    await walletRepo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });

    // Reconnect to a new instance: A is deactivated, B becomes the active one.
    await instanceRepo.deactivateActive(scope);
    const instanceB = await connectInstance("http://other.example:8899");
    await walletRepo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceB,
      walletId: "wal_2",
      pubkey: PUBKEY_B,
    });

    const [listed] = await repo.listByProject(scope);
    expect(listed.verified_wallet_count).toBe(1);
  });

  it("is 0 when the project has no active instance", async () => {
    const instanceA = await connectInstance();
    await walletRepo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });
    await instanceRepo.deactivateActive(scope);

    const [listed] = await repo.listByProject(scope);
    expect(listed.verified_wallet_count).toBe(0);
  });

  // project_role sources from project_members via LEFT JOIN so orphaned PCU
  // rows (user removed from project) stay visible for cleanup; invite-time
  // enforcement lives in the invite handler.
  it("surfaces the caller's project_members role", async () => {
    const db = getDb(env);
    await db
      .prepare("UPDATE project_members SET role = 'admin' WHERE id = ?")
      .bind(PROJECT_MEMBER_ID)
      .run();

    const [listed] = await repo.listByProject(scope);
    expect(listed.project_role).toBe("admin");
    const fetched = await repo.getByProjectAndUser(scope, TEST_USER.id);
    expect(fetched?.project_role).toBe("admin");
  });

  it("keeps the PCU visible with null role when project_members is removed", async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM project_members WHERE id = ?").bind(PROJECT_MEMBER_ID).run();

    const [listed] = await repo.listByProject(scope);
    expect(listed.project_role).toBeNull();
    const fetched = await repo.getByProjectAndUser(scope, TEST_USER.id);
    expect(fetched?.project_role).toBeNull();
  });
});
