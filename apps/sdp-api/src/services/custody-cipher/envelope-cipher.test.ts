import { describe, expect, it, vi } from "vitest";
import { KmsEnvelopeCipher } from "./envelope-cipher";

// Fake KMS: "wrap" = reversible XOR-with-0x5a so the test needs no real KMS.
function fakeKms() {
  const mask = (b: Uint8Array) => b.map((x) => x ^ 0x5a);
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  const un = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return {
    encrypt: vi.fn(async (pt: Uint8Array, _aad: string) => b64(mask(pt))),
    decrypt: vi.fn(async (ct: string, _aad: string) => mask(un(ct))),
  };
}

describe("KmsEnvelopeCipher", () => {
  it("round-trips plaintext and emits the v2 prefix", async () => {
    const kms = fakeKms();
    const cipher = new KmsEnvelopeCipher({ kms });

    const { ciphertext, version } = await cipher.encrypt("org1", "super-secret");

    expect(version).toBe("sdp-custody-kms-v2");
    expect(ciphertext.startsWith("v2.")).toBe(true);
    expect(await cipher.decrypt("org1", ciphertext)).toBe("super-secret");
  });

  it("binds the DEK to the org via AAD", async () => {
    const kms = fakeKms();
    const cipher = new KmsEnvelopeCipher({ kms });
    await cipher.encrypt("org1", "x");
    expect(kms.encrypt.mock.calls[0][1]).toBe("org:org1");
  });

  it("rejects ciphertext without the v2 prefix", async () => {
    const cipher = new KmsEnvelopeCipher({ kms: fakeKms() });
    await expect(cipher.decrypt("org1", "not-v2")).rejects.toThrow(/v2/i);
  });
});
