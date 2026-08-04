import { describe, expect, it } from "vitest";
import { createSpcCredentialCipher } from "@/lib/spc-credential-crypto";
import { EncryptionError, generateEncryptionKey } from "@/services/encryption.service";
import type { Env } from "@/types/env";

function envWith(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe("createSpcCredentialCipher", () => {
  it("round-trips under the legacy key alone", async () => {
    const cipher = createSpcCredentialCipher(
      envWith({ SPC_CREDENTIAL_ENCRYPTION_KEY: await generateEncryptionKey() })
    );

    const ciphertext = await cipher.encrypt("org_1", "spc-password");

    expect(await cipher.decrypt("org_1", ciphertext)).toBe("spc-password");
  });

  it("emits un-prefixed legacy ciphertext when no KMS key is configured", async () => {
    // v1 is the only scheme available off GCP (KMS auth needs the GCE metadata
    // server), so local dev, docker-compose, self-hosting and CI all depend on
    // this path staying un-prefixed and self-consistent.
    const cipher = createSpcCredentialCipher(
      envWith({ SPC_CREDENTIAL_ENCRYPTION_KEY: await generateEncryptionKey() })
    );

    expect(await cipher.encrypt("org_1", "spc-password")).not.toMatch(/^v2\./);
  });

  it("derives per-organization keys, so another org cannot decrypt", async () => {
    const cipher = createSpcCredentialCipher(
      envWith({ SPC_CREDENTIAL_ENCRYPTION_KEY: await generateEncryptionKey() })
    );

    const ciphertext = await cipher.encrypt("org_1", "spc-password");

    await expect(cipher.decrypt("org_2", ciphertext)).rejects.toThrow();
  });

  it("throws when neither the legacy key nor a KMS key is configured", () => {
    expect(() => createSpcCredentialCipher(envWith({}))).toThrow(EncryptionError);
  });
});
