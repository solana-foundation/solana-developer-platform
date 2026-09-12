import { ed25519DerivationPayload } from "@heliuslabs/zolana/keypair";
import { getBase64Codec, signBytes } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { canonicalShieldedIdentity } from "../material.js";
import {
  TEST_FOREIGN_REQUEST,
  TEST_OWNER,
  TEST_REQUEST,
  testSigner,
  testSignMessage,
} from "../test/shielded-identity-fixtures.js";
import { createCustodyMaterialSource } from "./derivation.js";

function source(signMessage = testSignMessage) {
  return createCustodyMaterialSource({ signMessage });
}

function identityFor(request = TEST_REQUEST, signMessage = testSignMessage): Promise<string> {
  return source(signMessage).withMaterial(request, async (material) =>
    canonicalShieldedIdentity(material.shieldedAddress)
  );
}

describe("createCustodyMaterialSource", () => {
  it("derives the same identity every time for one owner", async () => {
    expect(await identityFor()).toBe(await identityFor());
  });

  it("derives a different identity for a different owner", async () => {
    expect(await identityFor()).not.toBe(await identityFor(TEST_FOREIGN_REQUEST));
  });

  /**
   * The whole tenancy story rests on this: the seed is the owner's signature, so
   * the organization, project and wallet a request names cannot change the keys.
   * Two rings wallets over one custody wallet converge, which is what the
   * registry models — its record PDA is keyed on the owner and nothing else.
   */
  it("ignores the organization, project and wallet id", async () => {
    const elsewhere = {
      organizationId: "org_2",
      projectId: "proj_2",
      walletId: "hrw_2",
      owner: TEST_OWNER,
    };

    expect(await identityFor(elsewhere)).toBe(await identityFor());
  });

  it("rejects a signature over the bare payload a browser wallet would sign", async () => {
    // Phantom refuses the off-chain envelope, so it signs "TSPP/derive/v1" as
    // text. That is a valid signature over the wrong bytes: it yields a
    // different identity, so Zolana must refuse it rather than derive one.
    const bare: typeof testSignMessage = async () => {
      const signer = await testSigner();
      const signature = await signBytes(signer.keyPair.privateKey, ed25519DerivationPayload());
      return getBase64Codec().decode(signature);
    };

    await expect(identityFor(TEST_REQUEST, bare)).rejects.toThrow();
  });

  it("rejects a signature from a key that is not the owner's", async () => {
    const wrongKey: typeof testSignMessage = (messageBase64) =>
      testSignMessage(messageBase64, TEST_FOREIGN_REQUEST.owner);

    await expect(identityFor(TEST_REQUEST, wrongKey)).rejects.toThrow();
  });

  it.each([
    ["short", 32],
    ["long", 65],
  ])("rejects a %s signature at the custody boundary", async (_case, length) => {
    const wrongWidth: typeof testSignMessage = async () =>
      getBase64Codec().decode(new Uint8Array(length).fill(1));

    // Named at the boundary rather than left to fail inside key construction:
    // the fault is custody's, and the message should say so.
    await expect(identityFor(TEST_REQUEST, wrongWidth)).rejects.toThrow(
      /Custody returned a \d+-byte signature/
    );
  });

  it("signs the derivation message for the owner it was asked about", async () => {
    const signMessage = vi.fn(testSignMessage);

    await identityFor(TEST_REQUEST, signMessage);

    expect(signMessage).toHaveBeenCalledExactlyOnceWith(expect.any(String), TEST_OWNER);
  });

  /**
   * The contract that replaced the seed cache, asserted on ONE source: every
   * use fetches its own seed. Holding a seed between uses is what let a
   * non-reproducible signer look healthy until the entry expired, so a cache
   * reintroduced here has to fail a test rather than quietly restore that.
   */
  describe("no seed is held between uses", () => {
    it("signs again for a second use of one source", async () => {
      const signMessage = vi.fn(testSignMessage);
      const uncached = source(signMessage);

      await uncached.withMaterial(TEST_REQUEST, async () => undefined);
      await uncached.withMaterial(TEST_REQUEST, async () => undefined);

      expect(signMessage).toHaveBeenCalledTimes(2);
    });

    it("signs per concurrent use rather than joining one fetch", async () => {
      const signMessage = vi.fn(testSignMessage);
      const uncached = source(signMessage);

      await Promise.all(
        Array.from({ length: 4 }, () => uncached.withMaterial(TEST_REQUEST, async () => undefined))
      );

      // In-flight de-duplication went with the cache: four uses, four calls.
      expect(signMessage).toHaveBeenCalledTimes(4);
    });

    it("derives one identity across uses despite re-signing each time", async () => {
      const uncached = source();
      const read = () =>
        uncached.withMaterial(TEST_REQUEST, async (material) =>
          canonicalShieldedIdentity(material.shieldedAddress)
        );

      // The seed is zeroed after each use; a copy cleared in place would leave
      // the next use deriving from zeroes — well-formed, and a wrong identity.
      expect(await read()).toBe(await read());
    });
  });
});
