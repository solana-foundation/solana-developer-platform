import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { HeliusRingsKeyRefRepository } from "./helius-rings-key-ref.repository";
import { createPostgresHeliusRingsKeyRefRepository } from "./helius-rings-key-ref.repository.postgres";
import { createPostgresHeliusRingsWalletRepository } from "./helius-rings-wallet.repository.postgres";
import type { HeliusRingsZoneRepository } from "./helius-rings-zone.repository";
import { mapHeliusRingsZoneRow } from "./helius-rings-zone.repository";
import { createPostgresHeliusRingsZoneRepository } from "./helius-rings-zone.repository.postgres";

const TEST_PROJECT_ID = "prj_hrk_repo_test";
const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

let keyRefRepo: HeliusRingsKeyRefRepository;
let zoneRepo: HeliusRingsZoneRepository;
let walletId: string;
let otherWalletId: string;

describe("HeliusRingsKeyRefRepository / HeliusRingsZoneRepository (postgres)", () => {
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

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();

    const walletRepo = createPostgresHeliusRingsWalletRepository(db);
    const wallet = await walletRepo.createWallet({
      ...scope,
      sdpWalletId: "wal_hrk_repo_test",
      name: "Treasury",
      materialTag: "simulated",
    });
    const other = await walletRepo.createWallet({
      ...scope,
      sdpWalletId: "wal_hrk_repo_other",
      name: "Operations",
      materialTag: "simulated",
    });
    if (!wallet || !other) throw new Error("wallet fixtures were not created");
    walletId = wallet.id;
    otherWalletId = other.id;

    keyRefRepo = createPostgresHeliusRingsKeyRefRepository(db);
    zoneRepo = createPostgresHeliusRingsZoneRepository(db);
  });

  describe("key refs", () => {
    it("stores a sealed blob without interpreting it", async () => {
      const keyRef = await keyRefRepo.createKeyRef({
        walletId,
        kind: "viewing",
        ciphertext: "sealed-blob",
        keyVersion: "v1",
        materialTag: "simulated",
      });

      expect(keyRef).toMatchObject({
        wallet_id: walletId,
        kind: "viewing",
        ciphertext: "sealed-blob",
        key_version: "v1",
      });
    });

    it("does not re-seal on a replay, because the first blob owns the identity", async () => {
      const first = await keyRefRepo.createKeyRef({
        walletId,
        kind: "viewing",
        ciphertext: "sealed-first",
        keyVersion: "v1",
        materialTag: "simulated",
      });
      const replay = await keyRefRepo.createKeyRef({
        walletId,
        kind: "viewing",
        ciphertext: "sealed-second",
        keyVersion: "v2",
        materialTag: "simulated",
      });

      expect(replay?.id).toBe(first?.id);
      // Overwriting would strand the blob the shielded identity was derived
      // from and make the wallet unreachable.
      expect(replay?.ciphertext).toBe("sealed-first");
      expect(replay?.key_version).toBe("v1");
    });

    it("keeps one blob per kind per wallet", async () => {
      await keyRefRepo.createKeyRef({
        walletId,
        kind: "viewing",
        ciphertext: "sealed-viewing",
        keyVersion: "v1",
        materialTag: "simulated",
      });
      await keyRefRepo.createKeyRef({
        walletId,
        kind: "nullifier",
        ciphertext: "sealed-nullifier",
        keyVersion: "v1",
        materialTag: "simulated",
      });

      const listed = await keyRefRepo.listKeyRefsByWallet({ walletId });
      expect(listed.map((keyRef) => keyRef.kind)).toEqual(["nullifier", "viewing"]);
      expect(await keyRefRepo.getKeyRef({ walletId, kind: "viewing" })).toMatchObject({
        ciphertext: "sealed-viewing",
      });
    });

    it("does not leak another wallet's blobs", async () => {
      await keyRefRepo.createKeyRef({
        walletId,
        kind: "viewing",
        ciphertext: "sealed-viewing",
        keyVersion: "v1",
        materialTag: "simulated",
      });

      expect(await keyRefRepo.getKeyRef({ walletId: otherWalletId, kind: "viewing" })).toBeNull();
      expect(await keyRefRepo.listKeyRefsByWallet({ walletId: otherWalletId })).toEqual([]);
    });
  });

  describe("zones", () => {
    it("creates a zone", async () => {
      const zone = await zoneRepo.createZone({ walletId, name: "Payroll", kind: "treasury" });

      expect(zone).toMatchObject({ wallet_id: walletId, name: "Payroll", kind: "treasury" });
    });

    it("returns the existing zone on a replay without moving its kind", async () => {
      const first = await zoneRepo.createZone({ walletId, name: "Payroll", kind: "treasury" });
      const replay = await zoneRepo.createZone({ walletId, name: "Payroll", kind: "public" });

      expect(replay?.id).toBe(first?.id);
      // Changing the kind under a live operation would move its destination.
      expect(replay?.kind).toBe("treasury");
      expect(await zoneRepo.listZonesByWallet({ walletId })).toHaveLength(1);
    });

    it("lets two wallets each hold a zone of the same name", async () => {
      await zoneRepo.createZone({ walletId, name: "Payroll", kind: "treasury" });
      const other = await zoneRepo.createZone({
        walletId: otherWalletId,
        name: "Payroll",
        kind: "treasury",
      });

      expect(other?.wallet_id).toBe(otherWalletId);
    });

    it("scopes a zone read to its wallet", async () => {
      const zone = await zoneRepo.createZone({ walletId, name: "Payroll", kind: "treasury" });
      if (!zone) throw new Error("zone was not created");

      expect(await zoneRepo.getZoneById({ id: zone.id, walletId: otherWalletId })).toBeNull();
      expect(await zoneRepo.getZoneById({ id: zone.id, walletId })).toMatchObject({ id: zone.id });
    });

    it("maps a row onto the domain zone", async () => {
      const zone = await zoneRepo.createZone({ walletId, name: "Payroll", kind: "treasury" });
      if (!zone) throw new Error("zone was not created");

      expect(mapHeliusRingsZoneRow(zone)).toEqual({
        id: zone.id,
        name: "Payroll",
        kind: "treasury",
      });
    });
  });
});
