import { describe, expect, it } from "vitest";
import { canonicalShieldedIdentity, deriveShieldedMaterial } from "./identity.js";

const SEED_A = new Uint8Array(32).fill(7);
const SEED_B = new Uint8Array(32).fill(9);
const OWNER = "GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo";
const OTHER_OWNER = "6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM";

async function identityFor(seed: Uint8Array, scope: string, owner = OWNER): Promise<string> {
  const material = await deriveShieldedMaterial({ seed, scope, owner });
  try {
    return canonicalShieldedIdentity(material.shieldedAddress);
  } finally {
    material.destroy();
  }
}

describe("deriveShieldedMaterial", () => {
  it("is deterministic for the same seed, scope and owner", async () => {
    await expect(identityFor(SEED_A, "org/project/wallet")).resolves.toBe(
      await identityFor(SEED_A, "org/project/wallet")
    );
  });

  it("separates identities by scope", async () => {
    await expect(identityFor(SEED_A, "org/project/wallet-1")).resolves.not.toBe(
      await identityFor(SEED_A, "org/project/wallet-2")
    );
  });

  it("separates identities by seed", async () => {
    await expect(identityFor(SEED_A, "org/project/wallet")).resolves.not.toBe(
      await identityFor(SEED_B, "org/project/wallet")
    );
  });

  it("separates identities by owner", async () => {
    await expect(identityFor(SEED_A, "org/project/wallet")).resolves.not.toBe(
      await identityFor(SEED_A, "org/project/wallet", OTHER_OWNER)
    );
  });

  it("derives shielded keys independently of the owner", async () => {
    const first = await deriveShieldedMaterial({ seed: SEED_A, scope: "scope", owner: OWNER });
    const second = await deriveShieldedMaterial({
      seed: SEED_A,
      scope: "scope",
      owner: OTHER_OWNER,
    });

    try {
      // Two owners, one scope: the same viewing and nullifier keys under
      // different addresses. This is what lets custody hold the Ed25519 secret
      // while these keys are derived here.
      expect(second.viewingKey.secretBytes()).toStrictEqual(first.viewingKey.secretBytes());
      expect(second.nullifierKey.secretBytes()).toStrictEqual(first.nullifierKey.secretBytes());
      expect(second.shieldedAddress.ownerHash()).not.toStrictEqual(
        first.shieldedAddress.ownerHash()
      );
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  it("publishes the owner it was given", async () => {
    const material = await deriveShieldedMaterial({ seed: SEED_A, scope: "scope", owner: OWNER });
    try {
      expect(material.shieldedAddress.solanaAddress()).toBe(OWNER);
    } finally {
      material.destroy();
    }
  });

  it("rejects a seed that is not 32 bytes", async () => {
    await expect(
      deriveShieldedMaterial({ seed: new Uint8Array(31), scope: "scope", owner: OWNER })
    ).rejects.toThrow(/32 bytes/);
  });

  it("rejects an empty scope", async () => {
    await expect(deriveShieldedMaterial({ seed: SEED_A, scope: "", owner: OWNER })).rejects.toThrow(
      /scope/
    );
  });

  it("rejects an owner that is not a Solana address", async () => {
    await expect(
      deriveShieldedMaterial({ seed: SEED_A, scope: "scope", owner: "not-an-address" })
    ).rejects.toThrow();
  });

  // A registered identity's nullifier key never rotates, so a derivation change
  // is an identity conflict on every existing wallet rather than a new default.
  it("pins the canonical identity so a derivation change cannot pass silently", async () => {
    await expect(identityFor(SEED_A, "golden")).resolves.toBe(
      "21HFLCiaPXv9xhZzZdjZBrMV3D7B46Lx85e6w89u6HaL5Ps9avFnosfeKMFZ3dTtNDkrjS1mtwH2QygEYG37P677Y"
    );
  });
});
