import { HeliusRingsError } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { createRingsKeyCipher } from "./rings-key-crypto";

const KEY = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=";

describe("createRingsKeyCipher", () => {
  it("reports missing configuration as a Rings config error", () => {
    expect(() => createRingsKeyCipher({})).toThrow(
      expect.objectContaining<Partial<HeliusRingsError>>({ code: "config_error" })
    );
  });

  it("reports an invalid environment key as a Rings config error", () => {
    expect(() =>
      createRingsKeyCipher({ RINGS_KEY_ENCRYPTION_KEY: "not-32-bytes" })
    ).toThrow(expect.objectContaining<Partial<HeliusRingsError>>({ code: "config_error" }));
  });

  it("uses the v1 decryptor's strict base64 rules at startup", () => {
    // Buffer.from(base64) silently ignores this suffix and still reports 32
    // bytes, while the actual v1 decoder rejects it.
    expect(() =>
      createRingsKeyCipher({ RINGS_KEY_ENCRYPTION_KEY: `${KEY}!` })
    ).toThrow(/valid base64/i);
  });

  it("treats a blank KMS key name as absent", async () => {
    const cipher = createRingsKeyCipher({
      RINGS_KEY_ENCRYPTION_KEY: KEY,
      RINGS_KEY_KMS_KEY_NAME: "   ",
    } as Env);

    const ciphertext = await cipher.encrypt("org_1", "secret");
    expect(ciphertext.startsWith("v2.")).toBe(false);
    await expect(cipher.decrypt("org_1", ciphertext)).resolves.toBe("secret");
  });

  it("rejects KMS-only configuration because it cannot read legacy rows", () => {
    expect(() =>
      createRingsKeyCipher({
        RINGS_KEY_KMS_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      })
    ).toThrow(/RINGS_KEY_ENCRYPTION_KEY.*legacy v1/i);
  });

  it("rejects a malformed KMS resource name before startup", () => {
    expect(() =>
      createRingsKeyCipher({
        RINGS_KEY_ENCRYPTION_KEY: KEY,
        RINGS_KEY_KMS_KEY_NAME: "not-a-kms-resource",
      })
    ).toThrow(/KMS key name/i);
  });
});
