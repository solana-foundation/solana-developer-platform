import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DatabaseClient, getDb, type PreparedStatement } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresPrivateChannelInstanceRepository } from "./private-channel-instance.repository.postgres";
import type { PrivateChannelVerifiedWalletRepository } from "./private-channel-verified-wallet.repository";
import { createPostgresPrivateChannelVerifiedWalletRepository } from "./private-channel-verified-wallet.repository.postgres";

/**
 * Signal the test once a `SELECT ... FOR UPDATE` on the revocation-epoch row
 * has returned (the row lock is then held). The wrapper must survive the
 * `.bind()` chain — the repository always calls `prepare().bind().first()`.
 */
function signalAfterEpochRead(statement: PreparedStatement, signal: () => void): PreparedStatement {
  return {
    bind: (...values: unknown[]) => signalAfterEpochRead(statement.bind(...values), signal),
    first: async <T>(columnName?: string) => {
      const row = await statement.first<T>(columnName);
      signal();
      return row;
    },
    all: <T>() => statement.all<T>(),
    run: () => statement.run(),
  };
}

const TEST_PROJECT_ID = "prj_pcvw_repo_test";
const PCU_ID = "pcu_pcvw_repo_test";
const SECOND_PCU_ID = "pcu_pcvw_repo_test_second";

const PUBKEY_A = "So11111111111111111111111111111111111111112";
const PUBKEY_B = "So11111111111111111111111111111111111111113";

describe("PrivateChannelVerifiedWalletRepository (postgres)", () => {
  let repo: PrivateChannelVerifiedWalletRepository;
  let instanceA: string;

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
    await db.prepare("DELETE FROM private_channel_wallet_revocation_epochs").run();
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
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });

    const instanceRepo = createPostgresPrivateChannelInstanceRepository(db);
    const a = await instanceRepo.createActive({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      ...SANDBOX_DEFAULTS,
    });
    if (!a) throw new Error("createActive returned null");
    instanceA = a.id;

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
      expectedRevocationEpoch: 0,
    });
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_2",
      pubkey: PUBKEY_B,
      expectedRevocationEpoch: 0,
    });
    // Re-verify PUBKEY_A under a new wallet id: refresh, not a new row.
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1b",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
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
      expectedRevocationEpoch: 0,
    });

    await expect(
      repo.upsert({
        ...scope,
        userId: SECOND_PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
        expectedRevocationEpoch: 0,
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
      expectedRevocationEpoch: 0,
    });

    expect(await repo.findByInstanceAndPubkey(scope, instanceA, PUBKEY_A)).toMatchObject({
      user_id: PCU_ID,
      instance_id: instanceA,
      pubkey: PUBKEY_A,
    });
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
        expectedRevocationEpoch: 0,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await repo.listByUserAndInstance(PCU_ID, instanceA)).toEqual([]);
  });

  it("the cleanup claim records a retry marker and advances the epoch atomically", async () => {
    // The mirror from an earlier verification is already gone (revoked), but
    // the identity's late upstream binding may still exist: the claim records
    // the retry marker so the next principal-disable cleanup finds it.
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeTypeOf("string");
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toHaveLength(1);
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(1);

    // A successful compensating revoke removes the marker again with the
    // mirror; the epoch never resets. This is a real delete (no claim
    // watermark), so it clears whatever marker is present.
    await expect(
      repo.revokeVerifiedWallet({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(true);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toEqual([]);
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(2);
  });

  it("the cleanup claim stands down while the same identity's mirror exists", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });

    // A newer verification of the same identity has re-created the mirror: a
    // stale verification's compensating delete must not remove its binding.
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeNull();
    await expect(repo.listByUserAndInstance(PCU_ID, instanceA)).resolves.toHaveLength(1);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toEqual([]);
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(0);
  });

  it("a second cleanup claim stands down while the first claim's marker is fresh", async () => {
    const watermark = await repo.claimStaleVerificationCleanup({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });
    expect(watermark).toBeTypeOf("string");
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(1);

    // A second stale verification of the same wallet claims cleanup: SPC
    // keeps one binding per (SPC user, pubkey), so the first claim's single
    // compensating delete covers it too. The second claim must stand down —
    // two deletes would let the first finisher clear the shared marker while
    // the second delete is still in flight, and a fresh verification landing
    // in that window would lose its binding and mirror.
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_2",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeNull();
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(1);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toHaveLength(1);

    // Once the pending cleanup completes (its compensating revoke clears the
    // marker), a new claim is free again.
    await expect(
      repo.revokeVerifiedWallet({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(true);
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_2",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeTypeOf("string");
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(3);
  });

  it("a cleanup claim takes over a marker whose lease has expired", async () => {
    // Seed a marker whose owner died before its compensating delete (or that
    // the undecided-cleanup fallback recorded): older than the claim lease,
    // so no timeout-bounded compensating delete can still be in flight.
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO private_channel_wallet_revocations (
             id, organization_id, project_id, user_id, instance_id,
             wallet_id, pubkey, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "pcr_lease_expired",
        TEST_ORG.id,
        TEST_PROJECT_ID,
        PCU_ID,
        instanceA,
        "wal_1",
        PUBKEY_A,
        stale,
        stale
      )
      .run();

    // Taking the marker over is safe and converges the latch: the claim
    // advances the epoch and refreshes the marker's lease instead of
    // latching verifications here forever.
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeTypeOf("string");
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(1);
    const markers = await repo.listPendingRevocations(PCU_ID, instanceA);
    expect(markers).toHaveLength(1);
    expect(Date.now() - new Date(markers[0].updated_at).getTime()).toBeLessThan(60_000);
  });

  it("the fallback marker is recorded outside the cleanup lease and re-owns a pending claim's marker", async () => {
    // The undecided-cleanup fallback records a marker with no compensating
    // delete in flight: it is written already outside the lease, so the next
    // refused verification takes the cleanup over immediately.
    await expect(
      repo.recordPendingRevocation({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(true);
    const markers = await repo.listPendingRevocations(PCU_ID, instanceA);
    expect(markers).toHaveLength(1);
    expect(Date.now() - new Date(markers[0].updated_at).getTime()).toBeGreaterThan(30_000);
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeTypeOf("string");

    // A claimed marker is lease-fresh, so a second claim stands down. The
    // fallback record on the standing-down request RE-OWNS the marker instead
    // of leaving it: the claim's owner may be a delete that already returned
    // while its watermark-scoped clear has not landed, and that clear must
    // not destroy the record of the standing-down request's still-owed
    // delete. The re-own refreshes the lease (a claim must keep standing down
    // while the owner's delete can still be in flight) and preserves the
    // owner's claim_epoch, so the latch drops as soon as the owner converges.
    await expect(
      repo.revokeVerifiedWallet({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(true);
    const watermark = await repo.claimStaleVerificationCleanup({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_2",
      pubkey: PUBKEY_A,
    });
    expect(watermark).toBeTypeOf("string");
    const claimed = await repo.listPendingRevocations(PCU_ID, instanceA);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].updated_at).toBe(watermark);
    await expect(
      repo.recordPendingRevocation({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_2",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(true);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toHaveLength(1);
    const reOwned = await repo.listPendingRevocations(PCU_ID, instanceA);
    expect(reOwned[0].updated_at).not.toBe(watermark);
    // Lease-fresh: a second claim must keep standing down — the owner's
    // delete can still be in flight and the epoch has not moved past the
    // marker's claim_epoch.
    expect(Date.now() - new Date(reOwned[0].updated_at).getTime()).toBeLessThan(30_000);
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_3",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeNull();
  });

  it("a re-owned marker survives a watermark-scoped clear and stops latching once its owner converges", async () => {
    // The stand-down's bounded wait timed out while the pending cleaner's
    // marker was still fresh; the fallback re-owns the marker. The pending
    // cleaner's delete has already returned, and its watermark-scoped clear
    // runs afterwards: it must NOT remove the re-owned record, because the
    // standing-down request's own handshake may have created a binding the
    // pending delete never covered — with no mirror and no marker that late
    // binding would escape every later cleanup.
    const claimedWatermark = await repo.claimStaleVerificationCleanup({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });
    expect(claimedWatermark).toBeTypeOf("string");

    // The timed-out stand-down re-owns the marker (lease-fresh, same
    // claim_epoch: the owner's delete can still be in flight).
    await expect(
      repo.recordPendingRevocation({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(true);

    // The pending cleaner's convergence: its clear misses the re-owned
    // marker, so the marker survives (the epoch advance still commits).
    await expect(
      repo.revokeVerifiedWallet({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        pubkey: PUBKEY_A,
        claimedMarkerUpdatedAt: claimedWatermark as string,
      })
    ).resolves.toBe(false);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toHaveLength(1);
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(2);

    // The live epoch has moved past the marker's claim_epoch: the owner's
    // convergence committed, so the marker no longer latches the mirror
    // upsert — a verification that observed the live epoch lands safely and
    // re-owns the (possibly re-created) binding.
    await expect(
      repo.upsert({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_2",
        pubkey: PUBKEY_A,
        expectedRevocationEpoch: 2,
      })
    ).resolves.toMatchObject({ pubkey: PUBKEY_A, wallet_id: "wal_2" });

    // The lingering row is harmless discovery: a claim stands down for the
    // landed mirror (it belongs to this identity), and the principal-disable
    // cleanup still enumerates it.
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_2",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeNull();
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toHaveLength(1);
  });

  it("an epoch-stale re-owned marker is taken over immediately when no mirror landed", async () => {
    const claimedWatermark = await repo.claimStaleVerificationCleanup({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });
    expect(claimedWatermark).toBeTypeOf("string");
    await expect(
      repo.recordPendingRevocation({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(true);
    await expect(
      repo.revokeVerifiedWallet({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        pubkey: PUBKEY_A,
        claimedMarkerUpdatedAt: claimedWatermark as string,
      })
    ).resolves.toBe(false);

    // No mirror landed, so a further rejected verification must finish the
    // owed cleanup: the owner's convergence moved the epoch past the marker's
    // claim_epoch, so the claim takes the marker over immediately instead of
    // standing down for the rest of the lease.
    const takeoverWatermark = await repo.claimStaleVerificationCleanup({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_2",
      pubkey: PUBKEY_A,
    });
    expect(takeoverWatermark).toBeTypeOf("string");
    expect(takeoverWatermark).not.toBe(claimedWatermark);

    // The takeover's compensating clear (matching watermark) converges: the
    // marker is removed and the pubkey is verifiable again.
    await expect(
      repo.revokeVerifiedWallet({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        pubkey: PUBKEY_A,
        claimedMarkerUpdatedAt: takeoverWatermark as string,
      })
    ).resolves.toBe(true);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toEqual([]);
    await expect(
      repo.upsert({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_2",
        pubkey: PUBKEY_A,
        expectedRevocationEpoch: 4,
      })
    ).resolves.toMatchObject({ pubkey: PUBKEY_A, wallet_id: "wal_2" });
  });

  it("a compensating clear removes its own claimed marker while it still owns it", async () => {
    const watermark = await repo.claimStaleVerificationCleanup({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
    });
    expect(watermark).toBeTypeOf("string");

    // No re-own happened: the claim's clear still owns the marker and
    // removes it together with the epoch advance.
    await expect(
      repo.revokeVerifiedWallet({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        pubkey: PUBKEY_A,
        claimedMarkerUpdatedAt: watermark as string,
      })
    ).resolves.toBe(true);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toEqual([]);
  });

  it("the cleanup claim records cleanup independently when another identity owns the same pubkey", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO private_channel_users (
           id, organization_id, project_id, instance_id, name, is_default
         ) VALUES (?, ?, ?, ?, 'Second', FALSE)`
      )
      .bind(SECOND_PCU_ID, TEST_ORG.id, TEST_PROJECT_ID, instanceA)
      .run();
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_active",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });

    // The mirror belongs to the first identity, so the second identity's stale
    // verification may compensate its own late binding: the claim advances the
    // epoch and records its own retry marker without touching that mirror.
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: SECOND_PCU_ID,
        instanceId: instanceA,
        walletId: "wal_stale",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeTypeOf("string");

    await expect(repo.findByInstanceAndPubkey(scope, instanceA, PUBKEY_A)).resolves.toMatchObject({
      user_id: PCU_ID,
    });
    await expect(repo.listPendingRevocations(SECOND_PCU_ID, instanceA)).resolves.toHaveLength(1);
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(1);
  });

  it("the pending-revocation marker latches the conditional mirror upsert", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });
    await repo.revokeVerifiedWallet({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      pubkey: PUBKEY_A,
    });
    // A stale verification's cleanup claim: it advances the epoch and records
    // the retry marker for the compensating SPC delete it still owes.
    await expect(
      repo.claimStaleVerificationCleanup({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBeTypeOf("string");

    // A fresh verification that observed the advanced epoch must STILL lose:
    // while the marker is pending, the compensating delete targets the
    // binding a fresh verification would create, so the mirror must not land.
    // (It observed epoch 2 — the claim's advance — so this refusal is the
    // marker latch, not the epoch barrier.)
    await expect(
      repo.upsert({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_fresh",
        pubkey: PUBKEY_A,
        expectedRevocationEpoch: 2,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.listByUserAndInstance(PCU_ID, instanceA)).resolves.toEqual([]);

    // Completing the owed cleanup removes the marker with the mirror and the
    // epoch barrier stays: the pubkey is verifiable again.
    await repo.revokeVerifiedWallet({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      pubkey: PUBKEY_A,
    });
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toEqual([]);
    await expect(
      repo.upsert({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_fresh",
        pubkey: PUBKEY_A,
        expectedRevocationEpoch: 3,
      })
    ).resolves.toMatchObject({ pubkey: PUBKEY_A, wallet_id: "wal_fresh" });
  });

  it("recordPendingRevocation records the fallback marker without advancing the epoch", async () => {
    await expect(
      repo.recordPendingRevocation({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(true);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toHaveLength(1);
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(0);
  });

  it("recordPendingRevocation skips the marker when this identity's mirror owns the pubkey", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });

    // A newer verification of this identity has landed: its binding must
    // survive, and a marker here would latch the mirror upsert against the
    // row that already exists.
    await expect(
      repo.recordPendingRevocation({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(false);
    await expect(repo.listPendingRevocations(PCU_ID, instanceA)).resolves.toEqual([]);
  });

  it("recordPendingRevocation records independently when another identity owns the mirror", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO private_channel_users (
           id, organization_id, project_id, instance_id, name, is_default
         ) VALUES (?, ?, ?, ?, 'Second', FALSE)`
      )
      .bind(SECOND_PCU_ID, TEST_ORG.id, TEST_PROJECT_ID, instanceA)
      .run();
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_active",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });

    // The mirror belongs to the first identity, so the second identity's late
    // upstream binding (its own SPC user) still needs its retry marker.
    await expect(
      repo.recordPendingRevocation({
        ...scope,
        userId: SECOND_PCU_ID,
        instanceId: instanceA,
        walletId: "wal_stale",
        pubkey: PUBKEY_A,
      })
    ).resolves.toBe(true);
    await expect(repo.listPendingRevocations(SECOND_PCU_ID, instanceA)).resolves.toHaveLength(1);
    // The owning identity's mirror and epoch are untouched.
    await expect(repo.findByInstanceAndPubkey(scope, instanceA, PUBKEY_A)).resolves.toMatchObject({
      user_id: PCU_ID,
    });
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(0);
  });

  it("lists wallets by user and instance", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });

    expect(await repo.listByUserAndInstance(PCU_ID, instanceA)).toHaveLength(1);
  });

  it("revokeVerifiedWallet removes only the named pubkey and advances its epoch; stale → false", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_2",
      pubkey: PUBKEY_B,
      expectedRevocationEpoch: 0,
    });

    expect(
      await repo.revokeVerifiedWallet({
        ...scope,
        userId: "pcu_missing",
        instanceId: instanceA,
        pubkey: PUBKEY_A,
      })
    ).toBe(false);
    expect(
      await repo.revokeVerifiedWallet({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        pubkey: PUBKEY_A,
      })
    ).toBe(true);

    const rows = await repo.listByUserAndInstance(PCU_ID, instanceA);
    expect(rows.map((r) => r.pubkey)).toEqual([PUBKEY_B]);
    // The epoch is (instance, pubkey)-scoped and advances on every committed
    // revocation, even one that removed no mirror row for this identity.
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(2);
    // A different pubkey on the same instance has its own epoch.
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_B)).resolves.toBe(0);
  });

  it("the revocation epoch advances monotonically and gates the conditional upsert", async () => {
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(0);

    await repo.revokeVerifiedWallet({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      pubkey: PUBKEY_A,
    });
    await repo.revokeVerifiedWallet({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      pubkey: PUBKEY_A,
    });
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(2);

    // A verification that observed epoch 0 (stale continuation) loses.
    await expect(
      repo.upsert({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
        expectedRevocationEpoch: 0,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.listByUserAndInstance(PCU_ID, instanceA)).resolves.toEqual([]);

    // A verification that observed the current epoch lands and refreshes the
    // mirror: a fresh verify after a revocation stays supported.
    await expect(
      repo.upsert({
        ...scope,
        userId: PCU_ID,
        instanceId: instanceA,
        walletId: "wal_1",
        pubkey: PUBKEY_A,
        expectedRevocationEpoch: 2,
      })
    ).resolves.toMatchObject({ pubkey: PUBKEY_A, wallet_id: "wal_1" });
  });

  it("an upsert that holds the revocation barrier lands and cannot outlive the revocation", async () => {
    // The mirror from an earlier verification; no revocation has happened yet,
    // so the epoch row does not exist and this upsert creates it at 0.
    await repo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_1",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });

    const db = getDb(env);
    let signalEpochLockHeld!: () => void;
    const epochLockHeld = new Promise<void>((resolve) => {
      signalEpochLockHeld = resolve;
    });

    // The conditional upsert pins its epoch read with SELECT ... FOR UPDATE.
    // Signal only once that statement has RETURNED — the row lock is then
    // held — so the revocation below is guaranteed to block on the barrier
    // instead of committing before the upsert ever reads the epoch. Without
    // this gate the revocation could commit first and the test would pass
    // without exercising the lock at all (and an implementation that reads
    // the epoch unlocked would time out waiting for a signal never sent).
    const instrumentedDb: DatabaseClient = {
      prepare: (query) => db.prepare(query),
      queryOne: (query, params) => db.queryOne(query, params),
      queryMany: (query, params) => db.queryMany(query, params),
      execute: (query, params) => db.execute(query, params),
      batch: (statements) => db.batch(statements),
      transaction: (callback) =>
        db.transaction((tx) =>
          callback({
            prepare: (query) => {
              const statement = tx.prepare(query);
              if (
                query.includes("private_channel_wallet_revocation_epochs") &&
                query.includes("FOR UPDATE")
              ) {
                return signalAfterEpochRead(statement, signalEpochLockHeld);
              }
              return statement;
            },
            queryOne: (query, params) => tx.queryOne(query, params),
            queryMany: (query, params) => tx.queryMany(query, params),
            execute: (query, params) => tx.execute(query, params),
          })
        ),
    };
    const instrumentedRepo = createPostgresPrivateChannelVerifiedWalletRepository(instrumentedDb);

    // The overlapping verification observed epoch 0 before its SPC handshake
    // and reaches the barrier while no revocation is committed yet.
    const overlappingUpsert = instrumentedRepo.upsert({
      ...scope,
      userId: PCU_ID,
      instanceId: instanceA,
      walletId: "wal_overlap",
      pubkey: PUBKEY_A,
      expectedRevocationEpoch: 0,
    });
    await epochLockHeld;

    // The revocation starts while the upsert holds the barrier, so it blocks
    // until the upsert commits and only then removes the mirror it wrote.
    const revocation = db.transaction(async (tx) => {
      await tx
        .prepare(
          `INSERT INTO private_channel_wallet_revocation_epochs (
               organization_id, project_id, instance_id, pubkey, epoch
             )
             VALUES (?, ?, ?, ?, 1)
           ON CONFLICT (instance_id, pubkey) DO UPDATE
             SET epoch = private_channel_wallet_revocation_epochs.epoch + 1`
        )
        .bind(scope.organizationId, scope.projectId, instanceA, PUBKEY_A)
        .run();
      await tx
        .prepare(
          "DELETE FROM private_channel_verified_wallets WHERE user_id = ? AND instance_id = ? AND pubkey = ?"
        )
        .bind(PCU_ID, instanceA, PUBKEY_A)
        .run();
    });

    // The upsert observed the epoch it expected and lands — and the mirror it
    // wrote is then removed by the revocation, never outliving it. An
    // implementation that reads the epoch without the lock would resurrect
    // the mirror here (the revocation commits between its read and insert).
    await expect(overlappingUpsert).resolves.toMatchObject({
      wallet_id: "wal_overlap",
      pubkey: PUBKEY_A,
    });
    await revocation;

    await expect(repo.listByUserAndInstance(PCU_ID, instanceA)).resolves.toEqual([]);
    await expect(repo.getRevocationEpoch(instanceA, PUBKEY_A)).resolves.toBe(1);
  });
});
