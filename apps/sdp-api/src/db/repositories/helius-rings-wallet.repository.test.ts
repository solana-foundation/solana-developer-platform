import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { HeliusRingsWalletRepository } from "./helius-rings-wallet.repository";
import { mapHeliusRingsWalletRow } from "./helius-rings-wallet.repository";
import { createPostgresHeliusRingsWalletRepository } from "./helius-rings-wallet.repository.postgres";

const TEST_PROJECT_ID = "prj_hrw_repo_test";
const OTHER_PROJECT_ID = "prj_hrw_repo_other";

const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

let repo: HeliusRingsWalletRepository;

async function createWallet(sdpWalletId: string, name = "Treasury") {
  const wallet = await repo.createWallet({ ...scope, sdpWalletId, name, materialTag: "simulated" });
  if (!wallet) throw new Error("wallet fixture was not created");
  return wallet;
}

describe("HeliusRingsWalletRepository (postgres)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

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

    repo = createPostgresHeliusRingsWalletRepository(db);
  });

  it("creates a wallet pending with no shielded address", async () => {
    const wallet = await createWallet("wal_1");

    expect(wallet).toMatchObject({
      status: "pending",
      network: "devnet",
      shielded_address: null,
      sync_cursor: null,
      material_tag: "simulated",
    });
  });

  it("returns the existing wallet when provisioning is retried", async () => {
    const first = await createWallet("wal_1", "Treasury");
    // A second shielded identity over one custody wallet would split its
    // balance across two identities that cannot see each other.
    const replay = await createWallet("wal_1", "Renamed");

    expect(replay.id).toBe(first.id);
    expect(replay.name).toBe("Treasury");
    expect(await repo.listWallets(scope)).toHaveLength(1);
  });

  it("allows the same sdp wallet id under a different project", async () => {
    await createWallet("wal_shared");
    const other = await repo.createWallet({
      organizationId: TEST_ORG.id,
      projectId: OTHER_PROJECT_ID,
      sdpWalletId: "wal_shared",
      name: "Treasury",
      materialTag: "simulated",
    });

    expect(other?.project_id).toBe(OTHER_PROJECT_ID);
  });

  describe("markProvisioned", () => {
    it("attaches the shielded address and flips the wallet ready", async () => {
      const wallet = await createWallet("wal_1");

      const provisioned = await repo.markProvisioned({
        ...scope,
        id: wallet.id,
        shieldedAddress: "shielded-1",
        materialTag: "live",
        expectedStatus: "pending",
      });

      expect(provisioned).toMatchObject({
        status: "ready",
        shielded_address: "shielded-1",
        material_tag: "live",
      });
    });

    it("loses the compare-and-swap against a paused wallet", async () => {
      const wallet = await createWallet("wal_1");
      await repo.updateStatus({ ...scope, id: wallet.id, status: "paused" });

      // A late provisioning callback must not resurrect a wallet an operator
      // deliberately paused.
      const late = await repo.markProvisioned({
        ...scope,
        id: wallet.id,
        shieldedAddress: "shielded-1",
        materialTag: "live",
        expectedStatus: "pending",
      });

      expect(late).toBeNull();
      const current = await repo.getWalletById({ ...scope, id: wallet.id });
      expect(current).toMatchObject({ status: "paused", shielded_address: null });
    });
  });

  it("advances the sync cursor", async () => {
    const wallet = await createWallet("wal_1");

    const updated = await repo.updateSyncCursor({ ...scope, id: wallet.id, syncCursor: "slot:42" });

    expect(updated?.sync_cursor).toBe("slot:42");
  });

  it("scopes reads and writes to the owning tenant", async () => {
    const wallet = await createWallet("wal_1");
    const crossTenant = {
      organizationId: TEST_ORG.id,
      projectId: OTHER_PROJECT_ID,
    };

    expect(await repo.getWalletById({ ...crossTenant, id: wallet.id })).toBeNull();
    expect(await repo.getWalletBySdpWalletId({ ...crossTenant, sdpWalletId: "wal_1" })).toBeNull();
    expect(await repo.updateStatus({ ...crossTenant, id: wallet.id, status: "paused" })).toBeNull();
    expect(await repo.getWalletBySdpWalletId({ ...scope, sdpWalletId: "wal_1" })).toMatchObject({
      id: wallet.id,
    });
  });

  it("honours the list limit", async () => {
    await createWallet("wal_1");
    await createWallet("wal_2");

    expect(await repo.listWallets({ ...scope, limit: 1 })).toHaveLength(1);
  });

  describe("mapHeliusRingsWalletRow", () => {
    it("projects the row onto the domain wallet without tenant columns", async () => {
      const wallet = await createWallet("wal_1");
      const provisioned = await repo.markProvisioned({
        ...scope,
        id: wallet.id,
        shieldedAddress: "shielded-1",
        materialTag: "live",
        expectedStatus: "pending",
      });
      if (!provisioned) throw new Error("wallet was not provisioned");

      expect(mapHeliusRingsWalletRow(provisioned)).toEqual({
        id: wallet.id,
        sdpWalletId: "wal_1",
        name: "Treasury",
        shieldedAddress: "shielded-1",
        status: "ready",
        network: "devnet",
        syncCursor: null,
        materialTag: "live",
      });
    });
  });
});
