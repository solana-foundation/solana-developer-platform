import { HeliusRingsError, RINGS_KEY_AUTHORITIES } from "@sdp/helius-rings";
import {
  canonicalShieldedIdentity,
  type ShieldedMaterial,
  type ShieldedMaterialSource,
} from "@sdp/helius-rings-sdk";
import { describe, expect, it, vi } from "vitest";
import type {
  CreateHeliusRingsKeyRefInput,
  HeliusRingsKeyRefRepository,
  HeliusRingsKeyRefRow,
} from "@/db/repositories/helius-rings-key-ref.repository";
import type {
  HeliusRingsWalletRepository,
  HeliusRingsWalletRow,
} from "@/db/repositories/helius-rings-wallet.repository";
import type { CustodyCipher } from "@/services/custody-cipher/cipher-router";
import type { Env } from "@/types/env";
import { beginDbMaterialRotation, createDbMaterialSource } from "./database";
import {
  beginKeyAuthorityRotation,
  createRoutingMaterialSource,
  resolveDefaultKeyAuthority,
} from "./index";

const ORG = "org_ka";
const PROJECT = "prj_ka";
const OWNER = "11111111111111111111111111111112";
const OTHER_OWNER = "11111111111111111111111111111113";

const ENV = {
  ENVIRONMENT: "development",
  RINGS_KEY_ENCRYPTION_KEY: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=",
} as Env;

/**
 * Reversible stand-in for the cipher: these tests are about which bytes end up
 * sealed and read back, not about the encryption, and a real cipher would only
 * hide a mix-up behind opaque blobs.
 */
function fakeCipher(): CustodyCipher & { encryptCalls: string[] } {
  const encryptCalls: string[] = [];
  return {
    encryptCalls,
    async encrypt(orgId: string, plaintext: string) {
      encryptCalls.push(orgId);
      return `sealed(${orgId}):${plaintext}`;
    },
    async decrypt(orgId: string, ciphertext: string) {
      const prefix = `sealed(${orgId}):`;
      if (!ciphertext.startsWith(prefix)) {
        throw new Error(`ciphertext was not sealed for ${orgId}`);
      }
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
        previous_ciphertext: null,
        previous_key_version: null,
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
    // Mirrors the SQL: staging is all-or-nothing across both kinds, and restoring
    // fires on whatever is staged.
    async stageKeyRefRotation({ walletId, viewing, nullifier }) {
      const targets = [
        ["viewing", viewing],
        ["nullifier", nullifier],
      ] as const;
      const current = targets.map(([kind]) => rows.get(key(walletId, kind)));
      if (!current.every((row) => row !== undefined && row.previous_ciphertext === null)) {
        return [];
      }

      return targets.map(([kind, material], index) => {
        const existing = current[index] as HeliusRingsKeyRefRow;
        const staged: HeliusRingsKeyRefRow = {
          ...existing,
          ciphertext: material.ciphertext,
          key_version: material.keyVersion,
          previous_ciphertext: existing.ciphertext,
          previous_key_version: existing.key_version,
        };
        rows.set(key(walletId, kind), staged);
        return staged;
      });
    },
    async restoreKeyRefRotation({ walletId }) {
      const staged = [...rows.entries()].filter(
        ([, row]) => row.wallet_id === walletId && row.previous_ciphertext !== null
      );
      return staged.map(([mapKey, row]) => {
        const restored: HeliusRingsKeyRefRow = {
          ...row,
          ciphertext: row.previous_ciphertext as string,
          key_version: row.previous_key_version ?? row.key_version,
          previous_ciphertext: null,
          previous_key_version: null,
        };
        rows.set(mapKey, restored);
        return restored;
      });
    },
    async commitKeyRefRotation({ walletId }) {
      const staged = [...rows.entries()].filter(
        ([, row]) => row.wallet_id === walletId && row.previous_ciphertext !== null
      );
      for (const [mapKey, row] of staged) {
        rows.set(mapKey, { ...row, previous_ciphertext: null, previous_key_version: null });
      }
      return staged.length;
    },
  };
}

function walletRow(overrides: Partial<HeliusRingsWalletRow> = {}): HeliusRingsWalletRow {
  return {
    id: "hrw_1",
    organization_id: ORG,
    project_id: PROJECT,
    sdp_wallet_id: "wal_1",
    name: "Treasury",
    network: "devnet",
    status: "ready",
    shielded_address: "published",
    owner_address: OWNER,
    sync_cursor: null,
    last_indexed_slot: null,
    custody_wallet_id: "cwlt_1",
    material_tag: "live",
    key_authority: "deterministic",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Only `getWalletById` is reachable from the router, so the rest stays unbuilt. */
function fakeWallets(rows: readonly HeliusRingsWalletRow[]): HeliusRingsWalletRepository {
  const getWalletById: HeliusRingsWalletRepository["getWalletById"] = async ({ id }) =>
    rows.find((row) => row.id === id) ?? null;
  return { getWalletById } as HeliusRingsWalletRepository;
}

function router(
  rows: readonly HeliusRingsWalletRow[],
  keyRefs: HeliusRingsKeyRefRepository = fakeKeyRefs(),
  env: Env = ENV
) {
  return createRoutingMaterialSource({
    env,
    organizationId: ORG,
    projectId: PROJECT,
    wallets: () => fakeWallets(rows),
    keyRefs: () => keyRefs,
  });
}

/** The identity a source derives for one wallet, which is what callers compare. */
const identityOf = (source: ShieldedMaterialSource, walletId: string): Promise<string> =>
  source.withMaterial(
    { organizationId: ORG, projectId: PROJECT, walletId, owner: OWNER },
    async (material) => canonicalShieldedIdentity(material.shieldedAddress)
  );

const DEV = { ENVIRONMENT: "development" } as Env;
const PROD = { ENVIRONMENT: "production" } as Env;

describe("resolveDefaultKeyAuthority", () => {
  it("defaults to the seed-derived authority in development, where no key is configured", () => {
    expect(resolveDefaultKeyAuthority(DEV)).toBe("deterministic");
    expect(resolveDefaultKeyAuthority({ ...DEV, HELIUS_RINGS_KEY_AUTHORITY: "  " })).toBe(
      "deterministic"
    );
  });

  it("defaults to stored keys outside development", () => {
    // Fails closed: with no RINGS_KEY_ENCRYPTION_KEY this cannot provision at
    // all, which is the wanted outcome over minting derivable identities.
    expect(resolveDefaultKeyAuthority(PROD)).toBe("database");
    expect(resolveDefaultKeyAuthority({} as Env)).toBe("database");
  });

  it("accepts every registered authority in development", () => {
    for (const authority of RINGS_KEY_AUTHORITIES) {
      expect(resolveDefaultKeyAuthority({ ...DEV, HELIUS_RINGS_KEY_AUTHORITY: authority })).toBe(
        authority
      );
    }
  });

  it("refuses the seed-derived authority outside development", () => {
    expect(() =>
      resolveDefaultKeyAuthority({ ...PROD, HELIUS_RINGS_KEY_AUTHORITY: "deterministic" })
    ).toThrow(/cannot be 'deterministic' outside development/);
  });

  it("still allows stored keys outside development", () => {
    expect(resolveDefaultKeyAuthority({ ...PROD, HELIUS_RINGS_KEY_AUTHORITY: "database" })).toBe(
      "database"
    );
  });

  it("refuses an authority it has no implementation for", () => {
    expect(() =>
      resolveDefaultKeyAuthority({ ...DEV, HELIUS_RINGS_KEY_AUTHORITY: "enclave" })
    ).toThrow(HeliusRingsError);
  });
});

describe("createDbMaterialSource", () => {
  it("generates and seals both keys on a cold provision", async () => {
    const keyRefs = fakeKeyRefs();
    const cipher = fakeCipher();
    const source = createDbMaterialSource({
      keyRefs,
      cipher,
      organizationId: ORG,
      mayCreate: true,
    });

    const identity = await identityOf(source, "hrw_cold");

    expect(identity).toEqual(expect.any(String));
    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_cold" })).toHaveLength(2);
    // Sealed under the org, which is what scopes the cipher's derived key.
    expect(cipher.encryptCalls).toEqual([ORG, ORG]);
  });

  it("reads the sealed keys back rather than generating new ones", async () => {
    const keyRefs = fakeKeyRefs();
    const cipher = fakeCipher();
    const config = { keyRefs, cipher, organizationId: ORG, mayCreate: true };

    const first = await identityOf(createDbMaterialSource(config), "hrw_warm");
    const sealed = [...keyRefs.rows.values()].map((row) => row.ciphertext);

    // A later read is not allowed to create, which is how a real wallet's reads
    // arrive once it has published an identity.
    const second = await identityOf(
      createDbMaterialSource({ ...config, mayCreate: false }),
      "hrw_warm"
    );

    expect(second).toBe(first);
    expect([...keyRefs.rows.values()].map((row) => row.ciphertext)).toEqual(sealed);
  });

  it("records the cipher generation that sealed each row", async () => {
    const keyRefs = fakeKeyRefs();
    await identityOf(
      createDbMaterialSource({
        keyRefs,
        cipher: fakeCipher(),
        organizationId: ORG,
        mayCreate: true,
      }),
      "hrw_version"
    );

    for (const row of keyRefs.rows.values()) {
      expect(row.key_version).toBe("sdp-rings-key-encryption-v1");
      expect(row.material_tag).toBe("live");
    }
  });

  it("converges on one identity when two provisions race", async () => {
    const keyRefs = fakeKeyRefs();
    const config = { keyRefs, cipher: fakeCipher(), organizationId: ORG, mayCreate: true };

    const [left, right] = await Promise.all([
      identityOf(createDbMaterialSource(config), "hrw_race"),
      identityOf(createDbMaterialSource(config), "hrw_race"),
    ]);

    // The loser must adopt the winner's blobs for both kinds. Keeping its own
    // bytes for one kind would build an identity neither writer published.
    expect(left).toBe(right);
    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_race" })).toHaveLength(2);
  });

  it("refuses to seal keys for a wallet that already published an identity", async () => {
    const keyRefs = fakeKeyRefs();
    const source = createDbMaterialSource({
      keyRefs,
      cipher: fakeCipher(),
      organizationId: ORG,
      mayCreate: false,
    });

    await expect(identityOf(source, "hrw_lost")).rejects.toThrow(
      /no stored key material and is past provisioning/
    );
    expect(keyRefs.rows.size).toBe(0);
  });

  it("destroys the material when the caller throws", async () => {
    const source = createDbMaterialSource({
      keyRefs: fakeKeyRefs(),
      cipher: fakeCipher(),
      organizationId: ORG,
      mayCreate: true,
    });

    let captured: ShieldedMaterial | undefined;
    const boom = new Error("caller failed");

    await expect(
      source.withMaterial(
        { organizationId: ORG, projectId: PROJECT, walletId: "hrw_throw", owner: OWNER },
        async (material) => {
          captured = material;
          vi.spyOn(material, "destroy");
          throw boom;
        }
      )
    ).rejects.toBe(boom);

    expect(captured?.destroy).toHaveBeenCalled();
  });

  it("binds the identity to the owner it is asked for", async () => {
    const config = {
      keyRefs: fakeKeyRefs(),
      cipher: fakeCipher(),
      organizationId: ORG,
      mayCreate: true,
    };
    const source = createDbMaterialSource(config);

    const asOwner = await identityOf(source, "hrw_owner");
    const asOther = await source.withMaterial(
      { organizationId: ORG, projectId: PROJECT, walletId: "hrw_owner", owner: OTHER_OWNER },
      async (material) => canonicalShieldedIdentity(material.shieldedAddress)
    );

    // Same sealed keys, different owner: ownership enters the address as a hash
    // of the public key, so the identity has to move with it.
    expect(asOther).not.toBe(asOwner);
  });
});

describe("beginDbMaterialRotation", () => {
  it("replaces the sealed keys so the wallet derives a new identity", async () => {
    const keyRefs = fakeKeyRefs();
    const cipher = fakeCipher();
    const store = { keyRefs, cipher, organizationId: ORG };

    const before = await identityOf(
      createDbMaterialSource({ ...store, mayCreate: true }),
      "hrw_rot"
    );

    const rotation = await beginDbMaterialRotation({ ...store, walletId: "hrw_rot" });
    await rotation.commit();

    // Read-only afterwards, proving rotation left material behind rather than
    // relying on the next read to create it.
    const after = await identityOf(
      createDbMaterialSource({ ...store, mayCreate: false }),
      "hrw_rot"
    );

    expect(after).not.toBe(before);
    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_rot" })).toHaveLength(2);
  });

  it("serves the new identity as soon as it is staged, before any commit", async () => {
    const keyRefs = fakeKeyRefs();
    const store = { keyRefs, cipher: fakeCipher(), organizationId: ORG };
    const before = await identityOf(
      createDbMaterialSource({ ...store, mayCreate: true }),
      "hrw_stage"
    );

    await beginDbMaterialRotation({ ...store, walletId: "hrw_stage" });

    // The gateway publishes from the staged bytes, so they have to be what the
    // material source reads while the rotation is still undecided.
    expect(
      await identityOf(createDbMaterialSource({ ...store, mayCreate: false }), "hrw_stage")
    ).not.toBe(before);
  });

  it("restores the exact previous identity when the rotation is rolled back", async () => {
    const keyRefs = fakeKeyRefs();
    const store = { keyRefs, cipher: fakeCipher(), organizationId: ORG };
    const before = await identityOf(
      createDbMaterialSource({ ...store, mayCreate: true }),
      "hrw_back"
    );
    const sealedBefore = (await keyRefs.listKeyRefsByWallet({ walletId: "hrw_back" })).map(
      (row) => row.ciphertext
    );

    const rotation = await beginDbMaterialRotation({ ...store, walletId: "hrw_back" });
    await rotation.rollback();

    // The point of staging: a re-key that never reached the chain leaves the
    // wallet able to derive the identity it still advertises.
    expect(
      await identityOf(createDbMaterialSource({ ...store, mayCreate: false }), "hrw_back")
    ).toBe(before);
    expect(
      (await keyRefs.listKeyRefsByWallet({ walletId: "hrw_back" })).map((row) => row.ciphertext)
    ).toEqual(sealedBefore);
  });

  it("keeps the new keys and forgets the old ones once committed", async () => {
    const keyRefs = fakeKeyRefs();
    const store = { keyRefs, cipher: fakeCipher(), organizationId: ORG };
    await identityOf(createDbMaterialSource({ ...store, mayCreate: true }), "hrw_commit");

    const rotation = await beginDbMaterialRotation({ ...store, walletId: "hrw_commit" });
    const staged = await identityOf(
      createDbMaterialSource({ ...store, mayCreate: false }),
      "hrw_commit"
    );
    await rotation.commit();

    // A re-key prompted by a compromised key must not leave those bytes behind,
    // and a rollback after publication would abandon the published identity.
    const rows = await keyRefs.listKeyRefsByWallet({ walletId: "hrw_commit" });
    expect(rows.every((row) => row.previous_ciphertext === null)).toBe(true);
    await rotation.rollback();
    expect(
      await identityOf(createDbMaterialSource({ ...store, mayCreate: false }), "hrw_commit")
    ).toBe(staged);
  });

  it("stages both kinds together or not at all", async () => {
    const keyRefs = fakeKeyRefs();
    const store = { keyRefs, cipher: fakeCipher(), organizationId: ORG };
    await identityOf(createDbMaterialSource({ ...store, mayCreate: true }), "hrw_atomic");
    const before = await keyRefs.listKeyRefsByWallet({ walletId: "hrw_atomic" });

    // Half-staged is the state no process exit may produce: the two kinds would
    // come from different generations and derive an identity nobody published.
    const staged = await keyRefs.stageKeyRefRotation({
      walletId: "hrw_atomic",
      viewing: { ciphertext: "sealed(org_ka):new-viewing", keyVersion: "v2" },
      nullifier: { ciphertext: "sealed(org_ka):new-nullifier", keyVersion: "v2" },
    });

    expect(staged).toHaveLength(2);
    expect(staged.map((row) => row.previous_ciphertext)).toEqual(
      before.map((row) => row.ciphertext)
    );
  });

  it("refuses to stage when the wallet is already mid-rotation", async () => {
    const keyRefs = fakeKeyRefs();
    const store = { keyRefs, cipher: fakeCipher(), organizationId: ORG };
    await identityOf(createDbMaterialSource({ ...store, mayCreate: true }), "hrw_twice");
    await beginDbMaterialRotation({ ...store, walletId: "hrw_twice" });
    const staged = await keyRefs.listKeyRefsByWallet({ walletId: "hrw_twice" });

    // Each slot holds one blob, so restaging would discard the only material that
    // still derives the published identity.
    expect(
      await keyRefs.stageKeyRefRotation({
        walletId: "hrw_twice",
        viewing: { ciphertext: "sealed(org_ka):third-viewing", keyVersion: "v3" },
        nullifier: { ciphertext: "sealed(org_ka):third-nullifier", keyVersion: "v3" },
      })
    ).toEqual([]);
    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_twice" })).toEqual(staged);
  });

  it("adopts a rotation a crashed attempt left staged instead of stacking another", async () => {
    const keyRefs = fakeKeyRefs();
    const store = { keyRefs, cipher: fakeCipher(), organizationId: ORG };
    const original = await identityOf(
      createDbMaterialSource({ ...store, mayCreate: true }),
      "hrw_crash"
    );
    await beginDbMaterialRotation({ ...store, walletId: "hrw_crash" });
    const abandoned = await keyRefs.listKeyRefsByWallet({ walletId: "hrw_crash" });

    // The per-wallet lock is exclusive for the whole rotation, so finding one
    // staged means the attempt that staged it died before publishing. Publishing
    // it is better than staging again, which would bury the restorable material.
    const resumed = await beginDbMaterialRotation({ ...store, walletId: "hrw_crash" });

    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_crash" })).toEqual(abandoned);
    await resumed.rollback();
    expect(
      await identityOf(createDbMaterialSource({ ...store, mayCreate: false }), "hrw_crash")
    ).toBe(original);
  });

  it("seals fresh keys for a wallet that never provisioned", async () => {
    const keyRefs = fakeKeyRefs();
    const store = { keyRefs, cipher: fakeCipher(), organizationId: ORG };

    const rotation = await beginDbMaterialRotation({ ...store, walletId: "hrw_cold" });
    await rotation.commit();

    // Nothing to put back, so rotation degrades to a first seal rather than
    // failing on a missing row.
    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_cold" })).toHaveLength(2);
  });

  it("leaves other wallets untouched", async () => {
    const keyRefs = fakeKeyRefs();
    const store = { keyRefs, cipher: fakeCipher(), organizationId: ORG };

    const neighbour = await identityOf(
      createDbMaterialSource({ ...store, mayCreate: true }),
      "hrw_neighbour"
    );
    await identityOf(createDbMaterialSource({ ...store, mayCreate: true }), "hrw_target");

    const rotation = await beginDbMaterialRotation({ ...store, walletId: "hrw_target" });
    await rotation.commit();

    expect(
      await identityOf(createDbMaterialSource({ ...store, mayCreate: false }), "hrw_neighbour")
    ).toBe(neighbour);
  });
});

describe("beginKeyAuthorityRotation", () => {
  it("is a no-op for a seed-derived wallet, which has nothing to rotate", async () => {
    const keyRefs = fakeKeyRefs();

    const rotation = await beginKeyAuthorityRotation({
      env: ENV,
      organizationId: ORG,
      keyRefs,
      walletId: "hrw_det",
      keyAuthority: "deterministic",
    });
    // Both endings stay callable so the caller needs no special case.
    await rotation.rollback();
    await rotation.commit();

    expect(keyRefs.rows.size).toBe(0);
  });

  it("stages replacement material for a database wallet", async () => {
    const keyRefs = fakeKeyRefs();
    for (const kind of ["viewing", "nullifier"] as const) {
      await keyRefs.createKeyRef({
        walletId: "hrw_db",
        kind,
        ciphertext: `stale-${kind}`,
        keyVersion: "sdp-rings-key-encryption-v1",
        materialTag: "live",
      });
    }

    const rotation = await beginKeyAuthorityRotation({
      env: ENV,
      organizationId: ORG,
      keyRefs,
      walletId: "hrw_db",
      keyAuthority: "database",
    });
    await rotation.commit();

    const rows = await keyRefs.listKeyRefsByWallet({ walletId: "hrw_db" });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.ciphertext)).not.toContain("stale-viewing");
    expect(rows.map((row) => row.ciphertext)).not.toContain("stale-nullifier");
    // Committed, so the material it replaced is gone rather than recoverable.
    expect(rows.map((row) => row.previous_ciphertext)).toEqual([null, null]);
  });

  it("puts a database wallet's material back when the rotation is rolled back", async () => {
    const keyRefs = fakeKeyRefs();
    for (const kind of ["viewing", "nullifier"] as const) {
      await keyRefs.createKeyRef({
        walletId: "hrw_db_back",
        kind,
        ciphertext: `sealed(org_ka):${kind}-original`,
        keyVersion: "sdp-rings-key-encryption-v1",
        materialTag: "live",
      });
    }

    const rotation = await beginKeyAuthorityRotation({
      env: ENV,
      organizationId: ORG,
      keyRefs,
      walletId: "hrw_db_back",
      keyAuthority: "database",
    });
    await rotation.rollback();

    for (const kind of ["viewing", "nullifier"] as const) {
      const row = await keyRefs.getKeyRef({ walletId: "hrw_db_back", kind });
      expect(row?.ciphertext).toBe(`sealed(org_ka):${kind}-original`);
      expect(row?.previous_ciphertext).toBeNull();
    }
  });

  it("refuses to re-key a database wallet whose stored pair is incomplete", async () => {
    const keyRefs = fakeKeyRefs();
    await keyRefs.createKeyRef({
      walletId: "hrw_db_half",
      kind: "viewing",
      ciphertext: "sealed(org_ka):viewing-only",
      keyVersion: "sdp-rings-key-encryption-v1",
      materialTag: "live",
    });

    // One kind derives nothing, so this wallet never published an identity and a
    // re-key would be guessing. Filling the gap belongs to provisioning.
    await expect(
      beginKeyAuthorityRotation({
        env: ENV,
        organizationId: ORG,
        keyRefs,
        walletId: "hrw_db_half",
        keyAuthority: "database",
      })
    ).rejects.toThrow(/must hold one viewing and one nullifier key/);
  });

  it("refuses an authority this deployment does not implement", async () => {
    await expect(
      beginKeyAuthorityRotation({
        env: ENV,
        organizationId: ORG,
        keyRefs: fakeKeyRefs(),
        walletId: "hrw_x",
        keyAuthority: "enclave",
      })
    ).rejects.toThrow(/key authority this deployment does not support/);
  });
});

describe("createRoutingMaterialSource", () => {
  it("routes a wallet to the authority it is pinned to", async () => {
    const keyRefs = fakeKeyRefs();
    const rows = [
      walletRow({ id: "hrw_det", key_authority: "deterministic" }),
      walletRow({ id: "hrw_db", key_authority: "database", shielded_address: null }),
    ];

    await identityOf(router(rows, keyRefs), "hrw_det");
    await identityOf(router(rows, keyRefs), "hrw_db");

    // Only the database wallet leaves anything at rest; the seed-derived one
    // recomputes and stores nothing.
    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_det" })).toHaveLength(0);
    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_db" })).toHaveLength(2);
  });

  it("still serves a seed-pinned wallet in production", async () => {
    // Production refuses to *pin* new wallets to the seed, but refusing to serve
    // the ones pinned before that would brick them without making their keys any
    // less derivable. Migrating is what ends the exposure.
    const source = router([walletRow({ id: "hrw_legacy" })], fakeKeyRefs(), {
      ENVIRONMENT: "production",
    } as Env);

    await expect(identityOf(source, "hrw_legacy")).resolves.toEqual(expect.any(String));
  });

  it("serves both sides of a transfer across different authorities", async () => {
    const keyRefs = fakeKeyRefs();
    const source = router(
      [
        walletRow({ id: "hrw_sender", key_authority: "database", shielded_address: null }),
        walletRow({ id: "hrw_recipient", key_authority: "deterministic" }),
      ],
      keyRefs
    );

    const sender = await identityOf(source, "hrw_sender");
    const recipient = await identityOf(source, "hrw_recipient");

    expect(sender).not.toBe(recipient);
    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_recipient" })).toHaveLength(0);
  });

  it("lets a wallet mid-provision seal its keys", async () => {
    const keyRefs = fakeKeyRefs();
    const source = router(
      [walletRow({ id: "hrw_new", status: "pending", shielded_address: null })].map((row) => ({
        ...row,
        key_authority: "database" as const,
      })),
      keyRefs
    );

    await identityOf(source, "hrw_new");

    expect(await keyRefs.listKeyRefsByWallet({ walletId: "hrw_new" })).toHaveLength(2);
  });

  it("refuses to seal keys for a provisioned wallet that has none", async () => {
    const keyRefs = fakeKeyRefs();
    const source = router(
      [walletRow({ id: "hrw_ready", key_authority: "database", shielded_address: "published" })],
      keyRefs
    );

    // The regression this exists for: lifting a recipient's shielded address
    // must not mint and permanently seal keys for that recipient as a side
    // effect of someone else's transfer.
    await expect(identityOf(source, "hrw_ready")).rejects.toThrow(
      /no stored key material and is past provisioning/
    );
    expect(keyRefs.rows.size).toBe(0);
  });

  it("does not treat a quarantined wallet as mid-provision", async () => {
    // `paused` is where both a re-key claim and a quarantine land, so status
    // alone cannot authorize creation. A quarantined wallet still has its
    // published address, and that is what keeps it read-only here.
    const source = router([
      walletRow({ id: "hrw_paused", status: "paused", key_authority: "database" }),
    ]);

    await expect(identityOf(source, "hrw_paused")).rejects.toThrow(
      /no stored key material and is past provisioning/
    );
  });

  it("reads each wallet once per request", async () => {
    const rows = [walletRow({ id: "hrw_cached" })];
    const wallets = fakeWallets(rows);
    const getWalletById = vi.spyOn(wallets, "getWalletById");
    const source = createRoutingMaterialSource({
      env: ENV,
      organizationId: ORG,
      projectId: PROJECT,
      wallets: () => wallets,
      keyRefs: () => fakeKeyRefs(),
    });

    await identityOf(source, "hrw_cached");
    await identityOf(source, "hrw_cached");

    expect(getWalletById).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup", async () => {
    const wallets = fakeWallets([]);
    const getWalletById = vi.spyOn(wallets, "getWalletById");
    const source = createRoutingMaterialSource({
      env: ENV,
      organizationId: ORG,
      projectId: PROJECT,
      wallets: () => wallets,
      keyRefs: () => fakeKeyRefs(),
    });

    await expect(identityOf(source, "hrw_missing")).rejects.toThrow(/no Rings wallet with that id/);
    await expect(identityOf(source, "hrw_missing")).rejects.toThrow(/no Rings wallet with that id/);

    // A remembered rejection would make every later wallet in the same request
    // inherit this one's failure.
    expect(getWalletById).toHaveBeenCalledTimes(2);
  });

  it("refuses a wallet pinned to an authority it cannot serve", async () => {
    const source = router([walletRow({ id: "hrw_future", key_authority: "enclave" as never })]);

    await expect(identityOf(source, "hrw_future")).rejects.toThrow(
      /key authority this deployment does not support/
    );
  });
});
