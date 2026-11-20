import { describe, expect, it, vi } from "vitest";
import { fakeEnvelopeKms } from "@/test/helpers/custody-cipher";
import { KmsEnvelopeCipher } from "./envelope-cipher";

describe("KmsEnvelopeCipher", () => {
  it("round-trips plaintext and emits the v2 prefix", async () => {
    const cipher = new KmsEnvelopeCipher({ kms: fakeEnvelopeKms() });

    const { ciphertext, version } = await cipher.encrypt("org1", "super-secret");

    expect(version).toBe("sdp-custody-kms-v2");
    expect(ciphertext.startsWith("v2.")).toBe(true);
    expect(ciphertext).not.toContain("super-secret");
    expect(await cipher.decrypt("org1", ciphertext)).toBe("super-secret");
  });

  it("binds the data key to the organization with the org:<orgId> additional data", async () => {
    const kms = fakeEnvelopeKms();
    const encrypt = vi.spyOn(kms, "encrypt");
    const decrypt = vi.spyOn(kms, "decrypt");
    const cipher = new KmsEnvelopeCipher({ kms });

    const { ciphertext } = await cipher.encrypt("org1", "super-secret");
    await cipher.decrypt("org1", ciphertext);

    expect(encrypt).toHaveBeenCalledExactlyOnceWith(expect.any(Uint8Array), "org:org1");
    expect(decrypt).toHaveBeenCalledExactlyOnceWith(expect.any(String), "org:org1");
  });

  it("refuses to decrypt one organization's ciphertext for another", async () => {
    const cipher = new KmsEnvelopeCipher({ kms: fakeEnvelopeKms() });
    const { ciphertext } = await cipher.encrypt("org1", "super-secret");

    await expect(cipher.decrypt("org2", ciphertext)).rejects.toThrow("AAD mismatch");
  });

  it("rejects ciphertext without the v2 prefix", async () => {
    const cipher = new KmsEnvelopeCipher({ kms: fakeEnvelopeKms() });
    await expect(cipher.decrypt("org1", "not-v2")).rejects.toThrow(
      "ciphertext is not a v2 envelope"
    );
  });

  it.each(["v2.only-two", "v2.a.b.c"])("rejects the malformed envelope %s", async (ciphertext) => {
    const cipher = new KmsEnvelopeCipher({ kms: fakeEnvelopeKms() });
    await expect(cipher.decrypt("org1", ciphertext)).rejects.toThrow("malformed v2 envelope");
  });
});
