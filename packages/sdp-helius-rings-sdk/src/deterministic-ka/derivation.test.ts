import { hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalShieldedIdentity,
  type MaterialRequest,
  type ShieldedMaterial,
} from "../material.js";
import { createDeterministicMaterialSource, deriveMaterial } from "./derivation.js";

const SEED_A = new Uint8Array(32).fill(7);
const SEED_B = new Uint8Array(32).fill(9);
const OWNER = "GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo";
const OTHER_OWNER = "6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM";

const REQUEST: MaterialRequest = {
  organizationId: "org-1",
  projectId: "proj-1",
  walletId: "wallet-1",
  owner: OWNER,
};

async function identityFor(seed: Uint8Array, request: MaterialRequest): Promise<string> {
  const material = await deriveMaterial(seed, request);

  try {
    return canonicalShieldedIdentity(material.shieldedAddress);
  } finally {
    material.destroy();
  }
}

describe("deriveMaterial", () => {
  it("is deterministic for the same seed, tenant and owner", async () => {
    await expect(identityFor(SEED_A, REQUEST)).resolves.toBe(await identityFor(SEED_A, REQUEST));
  });

  it.each(["organizationId", "projectId", "walletId"] as const)(
    "separates identities by %s",
    async (component) => {
      await expect(identityFor(SEED_A, REQUEST)).resolves.not.toBe(
        await identityFor(SEED_A, { ...REQUEST, [component]: "other" })
      );
    }
  );

  it("separates identities by seed", async () => {
    await expect(identityFor(SEED_A, REQUEST)).resolves.not.toBe(
      await identityFor(SEED_B, REQUEST)
    );
  });

  it("separates identities by owner", async () => {
    await expect(identityFor(SEED_A, REQUEST)).resolves.not.toBe(
      await identityFor(SEED_A, { ...REQUEST, owner: OTHER_OWNER })
    );
  });

  it("rejects a seed that is not 32 bytes", async () => {
    await expect(deriveMaterial(new Uint8Array(31), REQUEST)).rejects.toThrow(/32 bytes/);
  });

  it.each(["organizationId", "projectId", "walletId"] as const)(
    "rejects an empty %s",
    async (component) => {
      await expect(deriveMaterial(SEED_A, { ...REQUEST, [component]: "" })).rejects.toThrow(
        new RegExp(component)
      );
    }
  );

  // Both spellings build the path a/b/c/d, so without this rejection two tenants
  // would share one shielded identity.
  it.each([
    { organizationId: "a/b", projectId: "c", walletId: "d" },
    { organizationId: "a", projectId: "b", walletId: "c/d" },
  ])("rejects a tenant component containing the separator", async (tenant) => {
    await expect(deriveMaterial(SEED_A, { ...REQUEST, ...tenant })).rejects.toThrow(
      /must not contain/
    );
  });

  // Restates the derivation from outside the module, so the pinned identity below
  // is anchored to a reviewable specification rather than to the code's output.
  it("derives both keys from the specified HKDF inputs", async () => {
    const path = `${REQUEST.organizationId}/${REQUEST.projectId}/${REQUEST.walletId}`;
    const salt = "sdp/helius-rings/deterministic-ka/v1";
    const material = await deriveMaterial(SEED_A, REQUEST);

    try {
      expect(material.viewingKey.secretBytes()).toStrictEqual(
        new Uint8Array(hkdfSync("sha256", SEED_A, salt, `viewing/${path}/0`, 32))
      );
      expect(material.nullifierKey.secretBytes()).toStrictEqual(
        new Uint8Array(hkdfSync("sha256", SEED_A, salt, `nullifier/${path}`, 31))
      );
    } finally {
      material.destroy();
    }
  });

  // SDP never re-keys a registered identity, so a derivation change is a conflict
  // on every existing wallet rather than a new default.
  it("pins the canonical identity so a derivation change cannot pass silently", async () => {
    await expect(identityFor(SEED_A, REQUEST)).resolves.toBe(
      "5CHr4u4PYY6jdJuhU72L8rLbiYkDVQiKLyaHQ6bNpRLyaNEFUaPnZRU6Uw7nnNAFEDzkF3kCDwBny6YkwRdpvhCbz"
    );
  });
});

describe("createDeterministicMaterialSource", () => {
  const source = createDeterministicMaterialSource({ seed: SEED_A });

  it("returns the callback result and destroys the material", async () => {
    let escaped: ShieldedMaterial | undefined;

    const result = await source.withMaterial(REQUEST, (material) => {
      escaped = material;
      return Promise.resolve(canonicalShieldedIdentity(material.shieldedAddress));
    });

    await expect(identityFor(SEED_A, REQUEST)).resolves.toBe(result);
    expect(() => escaped?.viewingKey.publicKey()).toThrow();
  });

  it("destroys the material when the callback throws", async () => {
    let escaped: ShieldedMaterial | undefined;

    await expect(
      source.withMaterial(REQUEST, (material) => {
        escaped = material;
        return Promise.reject(new Error("flow failed"));
      })
    ).rejects.toThrow(/flow failed/);
    expect(() => escaped?.viewingKey.publicKey()).toThrow();
  });
});
