import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresPrivateChannelRepository } from "./private-channel.repository.postgres";
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
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
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
    await getDb(env)
      .prepare(
        `UPDATE private_channel_users
            SET instance_id = ?, name = 'Default', is_default = TRUE
          WHERE id = ?`
      )
      .bind(created.id, PCU_ID)
      .run();
    return created.id;
  }

  async function markPrincipalProvisioned(): Promise<void> {
    await getDb(env)
      .prepare("UPDATE private_channel_users SET spc_user_id = 'spc_default' WHERE id = ?")
      .bind(PCU_ID)
      .run();
  }

  it("counts the member's wallets verified under the active instance", async () => {
    const instanceA = await connectInstance();
    await markPrincipalProvisioned();
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
    await markPrincipalProvisioned();
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
    await markPrincipalProvisioned();
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

  // project_role sources from project_members via LEFT JOIN so orphaned legacy
  // rows (user removed from project) stay visible for cleanup.
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

  it("does not expose an incomplete default principal as active", async () => {
    const instanceId = await connectInstance();

    await expect(repo.findDefaultPrincipal(scope, instanceId)).resolves.toBeNull();

    await getDb(env)
      .prepare(
        `UPDATE private_channel_users
            SET spc_user_id = 'spc_default',
                spc_username = 'default-user',
                spc_credential_ciphertext = 'encrypted'
          WHERE id = ?`
      )
      .bind(PCU_ID)
      .run();

    await expect(repo.findDefaultPrincipal(scope, instanceId)).resolves.toMatchObject({
      id: PCU_ID,
      spc_user_id: "spc_default",
    });
  });

  it("keeps an incomplete reservation available for provisioning recovery", async () => {
    const instanceId = await connectInstance();
    const db = getDb(env);
    await db.prepare("DELETE FROM private_channel_users WHERE id = ?").bind(PCU_ID).run();

    const reserved = await repo.reservePrincipal({
      ...scope,
      instanceId,
      name: "Treasury",
      isDefault: false,
      createdBy: TEST_USER.id,
      spcUsername: "treasury-recovery",
      spcCredentialCiphertext: "encrypted",
    });

    await expect(
      repo.findPrincipalReservation({ ...scope, instanceId, name: "Treasury" })
    ).resolves.toMatchObject({
      id: reserved.id,
      spc_username: "treasury-recovery",
      provisioned_at: null,
    });
  });

  it("does not add a membership after its principal is disabled", async () => {
    const instanceId = await connectInstance();
    const db = getDb(env);
    await db
      .prepare(
        `UPDATE private_channel_users
            SET is_default = FALSE,
                spc_user_id = 'spc_member',
                spc_username = 'member-user',
                spc_credential_ciphertext = 'encrypted'
          WHERE id = ?`
      )
      .bind(PCU_ID)
      .run();
    const { channel } = await createPostgresPrivateChannelRepository(db).getOrCreateDefault({
      ...scope,
      instanceId,
    });

    await expect(repo.disablePrincipal(scope, PCU_ID)).resolves.toBe(true);
    await expect(
      repo.addMembership({
        channelId: channel.id,
        privateChannelUserId: PCU_ID,
        addedBy: TEST_USER.id,
      })
    ).resolves.toBeNull();
  });
});
