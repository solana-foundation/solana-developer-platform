import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { createEncryptionService } from "../encryption.service";
import { assertCustodyEncryptionScheme, CustodyCipherRouter } from "./cipher-router";
import { KmsEnvelopeCipher } from "./envelope-cipher";

const LEGACY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
function fakeKms() {
  const mask = (b: Uint8Array) => b.map((x) => x ^ 0x5a);
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  const un = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return {
    encrypt: async (pt: Uint8Array) => b64(mask(pt)),
    decrypt: async (ct: string) => mask(un(ct)),
  };
}

describe("CustodyCipherRouter", () => {
  it("decrypts legacy ciphertext when active scheme is v2 (dual-read)", async () => {
    const legacy = createEncryptionService(LEGACY_KEY);
    const legacyCt = (await legacy.encrypt("org1", "secret")).ciphertext;
    const router = new CustodyCipherRouter({
      legacyKey: LEGACY_KEY,
      envelope: new KmsEnvelopeCipher({ kms: fakeKms() }),
      activeScheme: "v2",
    });

    expect(await router.decrypt("org1", legacyCt)).toBe("secret");
  });

  it("encrypts with v2 when active, and round-trips it", async () => {
    const router = new CustodyCipherRouter({
      legacyKey: LEGACY_KEY,
      envelope: new KmsEnvelopeCipher({ kms: fakeKms() }),
      activeScheme: "v2",
    });
    const ct = await router.encrypt("org1", "secret");
    expect(ct.startsWith("v2.")).toBe(true);
    expect(await router.decrypt("org1", ct)).toBe("secret");
  });

  it("encrypts with legacy when active scheme is legacy", async () => {
    const router = new CustodyCipherRouter({
      legacyKey: LEGACY_KEY,
      envelope: null,
      activeScheme: "legacy",
    });
    const ct = await router.encrypt("org1", "secret");
    expect(ct.startsWith("v2.")).toBe(false);
    expect(await router.decrypt("org1", ct)).toBe("secret");
  });

  describe("assertCustodyEncryptionScheme", () => {
    it("accepts a managed deployment that configures a KMS key", () => {
      expect(() =>
        assertCustodyEncryptionScheme({
          SDP_DEPLOYMENT_MODE: "managed",
          CUSTODY_KMS_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
        } as Env)
      ).not.toThrow();
    });

    it("rejects a managed deployment with no KMS key", () => {
      expect(() =>
        assertCustodyEncryptionScheme({
          SDP_DEPLOYMENT_MODE: "managed",
          CUSTODY_ENCRYPTION_KEY: LEGACY_KEY,
        } as Env)
      ).toThrow(/CUSTODY_KMS_KEY_NAME is required/);
    });

    it("rejects an unset deployment mode with no KMS key", () => {
      expect(() =>
        assertCustodyEncryptionScheme({ CUSTODY_ENCRYPTION_KEY: LEGACY_KEY } as Env)
      ).toThrow(/CUSTODY_KMS_KEY_NAME is required/);
    });

    it("allows a self-hosted deployment to keep the legacy key", () => {
      expect(() =>
        assertCustodyEncryptionScheme({
          SDP_DEPLOYMENT_MODE: "self_hosted",
          CUSTODY_ENCRYPTION_KEY: LEGACY_KEY,
        } as Env)
      ).not.toThrow();
    });

    it("treats a blank KMS key name as absent", () => {
      expect(() =>
        assertCustodyEncryptionScheme({
          SDP_DEPLOYMENT_MODE: "managed",
          CUSTODY_KMS_KEY_NAME: "   ",
        } as Env)
      ).toThrow(/CUSTODY_KMS_KEY_NAME is required/);
    });
  });
});
