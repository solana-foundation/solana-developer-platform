import { describe, expect, it } from "vitest";
import { createEncryptionService } from "@/services/encryption.service";
import { fakeEnvelopeKms, TEST_LEGACY_CUSTODY_KEY } from "@/test/helpers/custody-cipher";
import type { Env } from "@/types/env";
import { assertCustodyEncryptionScheme, CustodyCipherRouter } from "./cipher-router";
import { KmsEnvelopeCipher } from "./envelope-cipher";

function router(activeScheme: "legacy" | "v2") {
  return new CustodyCipherRouter({
    legacyKey: TEST_LEGACY_CUSTODY_KEY,
    envelope: new KmsEnvelopeCipher({ kms: fakeEnvelopeKms() }),
    activeScheme,
  });
}

function schemeEnv(fields: Pick<Env, "SDP_DEPLOYMENT_MODE" | "CUSTODY_KMS_KEY_NAME">): Env {
  // SAFETY: assertCustodyEncryptionScheme reads only the deployment mode and the KMS key name.
  return fields as Env;
}

describe("CustodyCipherRouter", () => {
  it("decrypts legacy ciphertext when the active scheme is v2", async () => {
    const legacyCiphertext = (
      await createEncryptionService(TEST_LEGACY_CUSTODY_KEY).encrypt("org1", "secret")
    ).ciphertext;

    expect(await router("v2").decrypt("org1", legacyCiphertext)).toBe("secret");
  });

  it("decrypts v2 ciphertext when the active scheme is legacy", async () => {
    const v2Ciphertext = await router("v2").encrypt("org1", "secret");

    expect(await router("legacy").decrypt("org1", v2Ciphertext)).toBe("secret");
  });

  it("encrypts with v2 when active, and round-trips it", async () => {
    const ciphertext = await router("v2").encrypt("org1", "secret");

    expect(ciphertext.startsWith("v2.")).toBe(true);
    expect(await router("v2").decrypt("org1", ciphertext)).toBe("secret");
  });

  it("encrypts with the legacy key when legacy is active, and round-trips it", async () => {
    const ciphertext = await router("legacy").encrypt("org1", "secret");

    expect(ciphertext.startsWith("v2.")).toBe(false);
    expect(ciphertext).not.toContain("secret");
    expect(await createEncryptionService(TEST_LEGACY_CUSTODY_KEY).decrypt("org1", ciphertext)).toBe(
      "secret"
    );
  });

  it.each(["legacy", "v2"] as const)(
    "refuses to decrypt one organization's %s ciphertext for another",
    async (activeScheme) => {
      const ciphertext = await router(activeScheme).encrypt("org1", "secret");

      await expect(router(activeScheme).decrypt("org2", ciphertext)).rejects.toThrow();
    }
  );

  describe("assertCustodyEncryptionScheme", () => {
    it("accepts a managed deployment that configures a KMS key", () => {
      expect(() =>
        assertCustodyEncryptionScheme(
          schemeEnv({
            SDP_DEPLOYMENT_MODE: "managed",
            CUSTODY_KMS_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
          })
        )
      ).not.toThrow();
    });

    it.each([
      ["a managed deployment", "managed", undefined],
      ["an unset deployment mode", undefined, undefined],
      ["a managed deployment with a blank key name", "managed", "   "],
    ] as const)("rejects %s without a KMS key", (_case, mode, keyName) => {
      expect(() =>
        assertCustodyEncryptionScheme(
          schemeEnv({ SDP_DEPLOYMENT_MODE: mode, CUSTODY_KMS_KEY_NAME: keyName })
        )
      ).toThrow(/CUSTODY_KMS_KEY_NAME is required/);
    });

    it("allows a self-hosted deployment to keep the legacy key", () => {
      expect(() =>
        assertCustodyEncryptionScheme(
          schemeEnv({ SDP_DEPLOYMENT_MODE: "self_hosted", CUSTODY_KMS_KEY_NAME: undefined })
        )
      ).not.toThrow();
    });
  });
});
