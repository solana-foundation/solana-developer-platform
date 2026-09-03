import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresPrivateChannelInstanceRepository } from "./private-channel-instance.repository.postgres";
import type { PrivateChannelVerifiedWalletRepository } from "./private-channel-verified-wallet.repository";
import { createPostgresPrivateChannelVerifiedWalletRepository } from "./private-channel-verified-wallet.repository.postgres";

const TEST_PROJECT_ID = "prj_pcvw_repo_test";
const OTHER_PROJECT_ID = "prj_pcvw_repo_test_other";
const PCU_ID = "pcu_pcvw_repo_test";
const SECOND_PCU_ID = "pcu_pcvw_repo_test_second";

const PUBKEY_A = "So11111111111111111111111111111111111111112";
const PUBKEY_B = "So11111111111111111111111111111111111111113";

describe("PrivateChannelVerifiedWalletRepository (postgres)", () => {
  let repo: PrivateChannelVerifiedWalletRepository;
  // Two distinct instances (one per project) give two FK-valid instance ids to
  // prove verifications don't leak across instances.
  let instanceA: string;
  let instanceB: string;

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

    const instanceRepo = createPostgresPrivateChannelInstanceRepository(db);
    const a = await instanceRepo.createActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
    });
    const b = await instanceRepo.createActive({
      organizationId: TEST_ORG.id,
      projectId: OTHER_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
      gatewayUrl: "http://other.example:8899",
    });
    if (!a || !b) throw new Error("createActive returned null");
    instanceA = a.id;
    instanceB = b.id;

    // The project identity (FK target for verified_wallets.user_id).
    await db
      .prepare(
        `INSERT INTO private_channel_users (
           id, organization_id, project_id, user_id, instance_id, name, is_default, spc_user_id
         ) VALUES (?, ?, ?, ?, ?, 'Default', TRUE, 'spc_default')`
      )
      .bind(PCU_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id, instanceA)
      .run();

    repo = createPostgresPrivateChannelVerifiedWalletRepository(db);
  });

  it("allows many wallets per (user, instance); re-verifying a pubkey refreshes in place", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_2",
      pubkey: PUBKEY_B,
    });
    // Re-verify PUBKEY_A under a new wallet id: refresh, not a new row.
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1b",
      pubkey: PUBKEY_A,
    });

    const rows = await repo.listByUserAndInstance(PCU_ID, instanceA);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.pubkey).sort()).toEqual([PUBKEY_A, PUBKEY_B].sort());
    expect(rows.find((r) => r.pubkey === PUBKEY_A)?.wallet_id).toBe("wal_1b");
  });

  it("returns a clear conflict when a wallet already identifies another principal", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO private_channel_users (
           id, organization_id, project_id, instance_id, name, is_default, spc_user_id
         ) VALUES (?, ?, ?, ?, 'Treasury', FALSE, 'spc_treasury')`
      )
      .bind(SECOND_PCU_ID, TEST_ORG.id, TEST_PROJECT_ID, instanceA)
      .run();

    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });

    await expect(
      repo.upsert({
        ...scope,
        userId: SECOND_PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This wallet is already linked to another identity. Select a different wallet.",
    });
  });

  it("finds the identity that owns a pubkey within the tenant scope", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });

    expect(await repo.findByInstanceAndPubkey(scope, instanceA, PUBKEY_A)).toMatchObject({
      user_id: PCU_ID,
      instance_id: instanceA,
      pubkey: PUBKEY_A,
    });
    expect(
      await repo.findByInstanceAndPubkey(
        { organizationId: TEST_ORG.id, projectId: OTHER_PROJECT_ID },
        instanceA,
        PUBKEY_A
      )
    ).toBeNull();
  });

  it("does not persist a wallet for a disabled identity", async () => {
    const db = getDb(env);
    await db
      .prepare("UPDATE private_channel_users SET disabled_at = sdp_iso_now() WHERE id = ?")
      .bind(PCU_ID)
      .run();

    await expect(
      repo.upsert({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await repo.listByUserAndInstance(PCU_ID, instanceA)).toEqual([]);
  });

  it("records a disabled identity's upstream binding for later cleanup", async () => {
    const db = getDb(env);
    await db
      .prepare("UPDATE private_channel_users SET disabled_at = sdp_iso_now() WHERE id = ?")
      .bind(PCU_ID)
      .run();

    const marker = await repo.recordPendingRevocation({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });

    expect(marker).toMatchObject({ user_id: PCU_ID, instance_id: instanceA, pubkey: PUBKEY_A });
    await expect(repo.listByUserAndInstance(PCU_ID, instanceA)).resolves.toEqual([]);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toHaveLength(1);
    await expect(repo.deletePendingRevocation(PCU_ID, instanceA, PUBKEY_A)).resolves.toBe(true);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toEqual([]);
  });

  it("records cleanup independently when another identity owns the same pubkey", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO private_channel_users (
           id, organization_id, project_id, instance_id, name, is_default, disabled_at
         ) VALUES (?, ?, ?, ?, 'Disabled', FALSE, sdp_iso_now())`
      )
      .bind(SECOND_PCU_ID, TEST_ORG.id, TEST_PROJECT_ID, instanceA)
      .run();
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_active",
      pubkey: PUBKEY_A,
    });

    await expect(
      repo.recordPendingRevocation({
        ...scope,
        userId: SECOND_PCU_ID,
        instanceId: instanceA,
        walletId: "wal_disabled",
        pubkey: PUBKEY_A,
      })
    ).resolves.toMatchObject({ user_id: SECOND_PCU_ID, pubkey: PUBKEY_A });

    await expect(repo.findByInstanceAndPubkey(scope, instanceA, PUBKEY_A)).resolves.toMatchObject({
      user_id: PCU_ID,
    });
    await expect(repo.listPendingRevocations(SECOND_PCU_ID, instanceA)).resolves.toHaveLength(1);
  });

  it("listByUserAndInstance is scoped to the instance (no cross-instance leak)", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });

    expect(await repo.listByUserAndInstance(PCU_ID, instanceA)).toHaveLength(1);
    expect(await repo.listByUserAndInstance(PCU_ID, instanceB)).toHaveLength(0);
  });

  it("deleteByUserInstanceAndPubkey removes only the named pubkey; stale pubkey → false", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_2",
      pubkey: PUBKEY_B,
    });

    // A pubkey verified only under another instance is not deletable here.
    expect(await repo.deleteByUserInstanceAndPubkey(PCU_ID, instanceB, PUBKEY_A)).toBe(false);
    expect(await repo.deleteByUserInstanceAndPubkey(PCU_ID, instanceA, PUBKEY_A)).toBe(true);

    const rows = await repo.listByUserAndInstance(PCU_ID, instanceA);
    expect(rows.map((r) => r.pubkey)).toEqual([PUBKEY_B]);
  });
});
