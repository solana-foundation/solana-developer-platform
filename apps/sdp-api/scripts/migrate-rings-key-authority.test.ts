import {
  canonicalShieldedIdentity,
  createDeterministicMaterialSource,
  createShieldedMaterial,
  deriveKeyBytes,
} from "@sdp/helius-rings-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CreateHeliusRingsKeyRefInput,
  HeliusRingsKeyRefRepository,
  HeliusRingsKeyRefRow,
} from "@/db/repositories/helius-rings-key-ref.repository";
import type { HeliusRingsWalletRow } from "@/db/repositories/helius-rings-wallet.repository";
import type { CustodyCipher } from "@/services/custody-cipher/cipher-router";
import { createDbMaterialSource } from "@/services/helius-rings/key-authority/database";
import { type MigrateWalletDeps, migrateWallet } from "./migrate-rings-key-authority";

const ORG = "org_mig";
const PROJECT = "prj_mig";
const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
/** Not the shipped seed, so these tests do not depend on its value. */
const SEED = new TextEncoder().encode("MIGRATION_TEST_SEED_32_BYTES!!!!");

function fakeCipher(): CustodyCipher {
  return {
    async encrypt(orgId, plaintext) {
      return `sealed(${orgId}):${plaintext}`;
    },
    async decrypt(orgId, ciphertext) {
      const prefix = `sealed(${orgId}):`;
      if (!ciphertext.startsWith(prefix)) throw new Error(`not sealed for ${orgId}`);
      return ciphertext.slice(prefix.length);
    },
  };
}

/** Honours the real write-once ON CONFLICT contract: a second seal never wins. */
function fakeKeyRefs(): HeliusRingsKeyRefRepository & { rows: Map<string, HeliusRingsKeyRefRow> } {
  const rows = new Map<string, HeliusRingsKeyRefRow>();
  const key = (walletId: string, kind: string) => `${walletId}/${kind}`;

  return {
    rows,
    async createKeyRef(input: CreateHeliusRingsKeyRefInput) {
      const existing = rows.get(key(input.walletId, input.kind));
      if (existing) return existing;
      const row: HeliusRingsKeyRefRow = {
        id: `hrk_${rows.size}`,
        wallet_id: input.walletId,
        kind: input.kind,
        ciphertext: input.ciphertext,
        key_version: input.keyVersion,
        material_tag: input.materialTag,
        created_at: "2026-01-01T00:00:00.000Z",
      };
      rows.set(key(input.walletId, input.kind), row);
      return row;
    },
    async getKeyRef({ walletId, kind }) {
      return rows.get(key(walletId, kind)) ?? null;
    },
    async listKeyRefsByWallet({ walletId }) {
      return [...rows.values()].filter((row) => row.wallet_id === walletId);
    },
    async deleteKeyRefsByWallet({ walletId }) {
      const doomed = [...rows.entries()].filter(([, row]) => row.wallet_id === walletId);
      for (const [mapKey] of doomed) rows.delete(mapKey);
      return doomed.length;
    },
  };
}

function walletRow(overrides: Partial<HeliusRingsWalletRow> = {}): HeliusRingsWalletRow {
  return {
    id: "hrw_mig",
    organization_id: ORG,
    project_id: PROJECT,
    sdp_wallet_id: "wal_mig",
    name: "Treasury",
    network: "devnet",
    status: "ready",
    shielded_address: null,
    owner_address: OWNER,
    sync_cursor: "cursor",
    last_indexed_slot: "42",
    custody_wallet_id: "cwlt_1",
    material_tag: "live",
    key_authority: "deterministic",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The identity the seed authority publishes for a wallet, as it stands today. */
function seedIdentity(wallet: HeliusRingsWalletRow): Promise<string> {
  return createDeterministicMaterialSource({ seed: SEED }).withMaterial(
    {
      organizationId: wallet.organization_id,
      projectId: wallet.project_id,
      walletId: wallet.id,
      owner: wallet.owner_address ?? OWNER,
    },
    async (material) => canonicalShieldedIdentity(material.shieldedAddress)
  );
}

let keyRefs: ReturnType<typeof fakeKeyRefs>;
let store: Map<string, HeliusRingsWalletRow>;
let deps: MigrateWalletDeps;

function migrate(wallet: HeliusRingsWalletRow) {
  return migrateWallet(wallet, deps);
}

/** What the database authority derives after the migration has run. */
function identityAfterMigration(wallet: HeliusRingsWalletRow): Promise<string> {
  return createDbMaterialSource({
    keyRefs,
    cipher: fakeCipher(),
    organizationId: wallet.organization_id,
    // Read-only, matching how a provisioned wallet is served in production. Had
    // the migration stored nothing, this throws rather than papering over the gap
    // by generating keys.
    mayCreate: false,
  }).withMaterial(
    {
      organizationId: wallet.organization_id,
      projectId: wallet.project_id,
      walletId: wallet.id,
      owner: wallet.owner_address ?? OWNER,
    },
    async (material) => canonicalShieldedIdentity(material.shieldedAddress)
  );
}

describe("migrateWallet", () => {
  beforeEach(() => {
    keyRefs = fakeKeyRefs();
    store = new Map();
    deps = {
      keyRefs,
      cipher: fakeCipher(),
      seed: SEED,
      // Mirrors the script's CAS: only moves a row still pinned deterministic.
      repin: async (wallet) => {
        const row = store.get(wallet.id);
        if (row?.key_authority !== "deterministic") return false;
        store.set(wallet.id, { ...row, key_authority: "database" });
        return true;
      },
    };
  });

  it("preserves a provisioned wallet's identity", async () => {
    const wallet = walletRow({ shielded_address: await seedIdentity(walletRow()) });
    store.set(wallet.id, wallet);

    const outcome = await migrate(wallet);

    expect(outcome).toEqual({ kind: "migrated", shieldedAddress: wallet.shielded_address });
    // The point of the whole exercise: same identity, so the wallet's notes stay
    // spendable and nothing had to touch the chain.
    expect(await identityAfterMigration(wallet)).toBe(wallet.shielded_address);
    expect(store.get(wallet.id)?.key_authority).toBe("database");
  });

  it("seals exactly the bytes the seed derives", async () => {
    const wallet = walletRow({ shielded_address: await seedIdentity(walletRow()) });
    store.set(wallet.id, wallet);

    await migrate(wallet);

    const derived = deriveKeyBytes(SEED, {
      organizationId: ORG,
      projectId: PROJECT,
      walletId: wallet.id,
      owner: OWNER,
    });
    const cipher = fakeCipher();
    const sealed = async (kind: "viewing" | "nullifier") => {
      const row = await keyRefs.getKeyRef({ walletId: wallet.id, kind });
      if (!row) throw new Error(`${kind} was not sealed`);
      return new Uint8Array(Buffer.from(await cipher.decrypt(ORG, row.ciphertext), "base64"));
    };

    expect(await sealed("viewing")).toEqual(derived.viewingKeyBytes);
    expect(await sealed("nullifier")).toEqual(derived.nullifierKeyBytes);
  });

  it("re-pins an unprovisioned wallet without sealing public keys into it", async () => {
    const wallet = walletRow({ status: "pending", shielded_address: null });
    store.set(wallet.id, wallet);

    expect(await migrate(wallet)).toEqual({ kind: "repinned-unprovisioned" });
    expect(store.get(wallet.id)?.key_authority).toBe("database");
    // Importing seed-derived keys here would be strictly worse than letting it
    // generate random ones when it provisions.
    expect(keyRefs.rows.size).toBe(0);
  });

  it("is a no-op on a wallet already migrated", async () => {
    const wallet = walletRow({ key_authority: "database", shielded_address: "published" });
    store.set(wallet.id, wallet);

    expect(await migrate(wallet)).toEqual({ kind: "already-migrated" });
    expect(keyRefs.rows.size).toBe(0);
  });

  it("converges when rerun, which is how the script is meant to be used", async () => {
    const wallet = walletRow({ shielded_address: await seedIdentity(walletRow()) });
    store.set(wallet.id, wallet);

    const first = await migrate(wallet);
    // Reruns re-read the row, so the second pass sees the migrated pin.
    const second = await migrate(store.get(wallet.id) as HeliusRingsWalletRow);

    expect(first.kind).toBe("migrated");
    expect(second).toEqual({ kind: "already-migrated" });
    expect(await identityAfterMigration(wallet)).toBe(wallet.shielded_address);
  });

  it("refuses a wallet whose published identity the seed does not reproduce", async () => {
    const foreign = await createShieldedMaterial({
      ...deriveKeyBytes(new TextEncoder().encode("A_DIFFERENT_SEED_32_BYTES_LONG!!"), {
        organizationId: ORG,
        projectId: PROJECT,
        walletId: "hrw_mig",
        owner: OWNER,
      }),
      owner: OWNER,
    });
    const shieldedAddress = canonicalShieldedIdentity(foreign.shieldedAddress);
    foreign.destroy();

    const wallet = walletRow({ shielded_address: shieldedAddress });
    store.set(wallet.id, wallet);

    const outcome = await migrate(wallet);

    // Sealing unverified bytes would make the mismatch permanent, because
    // createKeyRef never overwrites.
    expect(outcome.kind).toBe("skipped");
    expect(keyRefs.rows.size).toBe(0);
    expect(store.get(wallet.id)?.key_authority).toBe("deterministic");
  });

  it("refuses a provisioned wallet with no owner to verify against", async () => {
    const wallet = walletRow({ shielded_address: "published", owner_address: null });
    store.set(wallet.id, wallet);

    expect(await migrate(wallet)).toMatchObject({ kind: "skipped" });
    expect(keyRefs.rows.size).toBe(0);
    expect(store.get(wallet.id)?.key_authority).toBe("deterministic");
  });

  describe("dry run", () => {
    it("predicts a migration without writing anything", async () => {
      const wallet = walletRow({ shielded_address: await seedIdentity(walletRow()) });
      store.set(wallet.id, wallet);

      const outcome = await migrateWallet(wallet, { ...deps, dryRun: true });

      expect(outcome).toEqual({ kind: "migrated", shieldedAddress: wallet.shielded_address });
      expect(keyRefs.rows.size).toBe(0);
      expect(store.get(wallet.id)?.key_authority).toBe("deterministic");
    });

    it("predicts the same skip the real run reaches, rather than counting candidates", async () => {
      // The finding this exists for: a preview that skipped the checks reported
      // every seed-pinned wallet as migratable, including ones the real run refuses.
      const wallet = walletRow({ shielded_address: "published-by-something-else" });
      store.set(wallet.id, wallet);

      const previewed = await migrateWallet(wallet, { ...deps, dryRun: true });
      const real = await migrate(wallet);

      expect(previewed.kind).toBe("skipped");
      expect(real.kind).toBe("skipped");
    });

    it("predicts a skip for a provisioned wallet with no owner to verify against", async () => {
      const wallet = walletRow({ shielded_address: "published", owner_address: null });
      store.set(wallet.id, wallet);

      expect(await migrateWallet(wallet, { ...deps, dryRun: true })).toMatchObject({
        kind: "skipped",
      });
    });

    it("predicts a skip when existing material would not match the derivation", async () => {
      const wallet = walletRow({ shielded_address: await seedIdentity(walletRow()) });
      store.set(wallet.id, wallet);
      await keyRefs.createKeyRef({
        walletId: wallet.id,
        kind: "viewing",
        ciphertext: `sealed(${ORG}):${Buffer.from(new Uint8Array(32).fill(7)).toString("base64")}`,
        keyVersion: "sdp-rings-key-encryption-v1",
        materialTag: "live",
      });

      // Sealing is write-once, so the real run would keep this blob and skip.
      // A preview that only derived would have reported a clean migration.
      expect(await migrateWallet(wallet, { ...deps, dryRun: true })).toMatchObject({
        kind: "skipped",
      });
    });

    it("predicts a re-pin for an unprovisioned wallet without touching it", async () => {
      const wallet = walletRow({ status: "pending", shielded_address: null });
      store.set(wallet.id, wallet);

      expect(await migrateWallet(wallet, { ...deps, dryRun: true })).toEqual({
        kind: "repinned-unprovisioned",
      });
      expect(store.get(wallet.id)?.key_authority).toBe("deterministic");
    });
  });

  it("leaves the pin alone when another writer moved the wallet first", async () => {
    const wallet = walletRow({ shielded_address: await seedIdentity(walletRow()) });
    // The row the caller read says deterministic; the store has already moved on.
    store.set(wallet.id, { ...wallet, key_authority: "database" });

    expect(await migrate(wallet)).toMatchObject({ kind: "skipped" });
  });
});
