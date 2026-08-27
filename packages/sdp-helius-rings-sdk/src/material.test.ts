import { describe, expect, it } from "vitest";
import {
  assertShieldedIdentity,
  canonicalShieldedIdentity,
  createShieldedMaterial,
  isValidViewingKeyBytes,
  RingsIdentityMismatchError,
  type ShieldedMaterialInput,
} from "./material.js";

const VIEWING_KEY_BYTES = new Uint8Array(32).fill(7);
const NULLIFIER_KEY_BYTES = new Uint8Array(31).fill(11);
const OWNER = "GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo";
const OTHER_OWNER = "6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM";

const INPUT: ShieldedMaterialInput = {
  viewingKeyBytes: VIEWING_KEY_BYTES,
  nullifierKeyBytes: NULLIFIER_KEY_BYTES,
  owner: OWNER,
};

describe("isValidViewingKeyBytes", () => {
  it("accepts 32 in-range bytes", () => {
    expect(isValidViewingKeyBytes(VIEWING_KEY_BYTES)).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isValidViewingKeyBytes(new Uint8Array(31).fill(7))).toBe(false);
  });

  it("rejects an out-of-range scalar", () => {
    expect(isValidViewingKeyBytes(new Uint8Array(32).fill(0xff))).toBe(false);
  });
});

describe("createShieldedMaterial", () => {
  it("publishes the owner it was given", async () => {
    const material = await createShieldedMaterial(INPUT);

    try {
      expect(material.shieldedAddress.solanaAddress()).toBe(OWNER);
    } finally {
      material.destroy();
    }
  });

  it("keeps the shielded keys independent of the owner", async () => {
    const first = await createShieldedMaterial(INPUT);
    const second = await createShieldedMaterial({ ...INPUT, owner: OTHER_OWNER });

    try {
      // Identical secrets under different addresses, which is what lets custody
      // hold the Ed25519 secret while these keys are produced elsewhere.
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

  it("rejects viewing key bytes of the wrong length", async () => {
    await expect(
      createShieldedMaterial({ ...INPUT, viewingKeyBytes: new Uint8Array(31).fill(7) })
    ).rejects.toThrow(/viewing key must be 32 bytes/);
  });

  it("rejects nullifier key bytes of the wrong length", async () => {
    await expect(
      createShieldedMaterial({ ...INPUT, nullifierKeyBytes: new Uint8Array(32).fill(11) })
    ).rejects.toThrow(/nullifier key must be 31 bytes/);
  });

  it("rejects an owner that is not a Solana address", async () => {
    await expect(createShieldedMaterial({ ...INPUT, owner: "not-an-address" })).rejects.toThrow();
  });

  it("leaves both keys unusable after destroy", async () => {
    const material = await createShieldedMaterial(INPUT);
    material.destroy();

    expect(() => material.viewingKey.publicKey()).toThrow();
    expect(() => material.nullifierKey.publicKey()).toThrow();
  });
});

describe("assertShieldedIdentity", () => {
  it("accepts the identity the material publishes", async () => {
    const material = await createShieldedMaterial(INPUT);

    try {
      const expected = canonicalShieldedIdentity(material.shieldedAddress);
      expect(() => assertShieldedIdentity(material, expected)).not.toThrow();
    } finally {
      material.destroy();
    }
  });

  it("fails closed when the persisted identity does not match", async () => {
    const material = await createShieldedMaterial(INPUT);
    const other = await createShieldedMaterial({ ...INPUT, owner: OTHER_OWNER });

    try {
      expect(() =>
        assertShieldedIdentity(material, canonicalShieldedIdentity(other.shieldedAddress))
      ).toThrow(RingsIdentityMismatchError);
    } finally {
      material.destroy();
      other.destroy();
    }
  });
});
