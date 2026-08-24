import { describe, expect, it } from "vitest";
import { createEncryptionService } from "../encryption.service";
import { CustodyCipherRouter } from "./cipher-router";
import { KmsEnvelopeCipher } from "./envelope-cipher";
import { migrateNestedCustodySecrets } from "./nested-secret-migration";

const LEGACY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
function fakeKms() {
  const mask = (b: Uint8Array) => b.map((x) => x ^ 0x5a);
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  const un = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return {
    encrypt: async (pt: Uint8Array, aad: string) => `${btoa(aad)}!${b64(mask(pt))}`,
    decrypt: async (ct: string, aad: string) => {
      const [boundAad, payload] = ct.split("!");
      if (boundAad !== btoa(aad) || !payload) {
        throw new Error("AAD mismatch");
      }
      return mask(un(payload));
    },
  };
}

function v2Router() {
  return new CustodyCipherRouter({
    legacyKey: LEGACY_KEY,
    envelope: new KmsEnvelopeCipher({ kms: fakeKms() }),
    activeScheme: "v2",
  });
}

async function legacyCiphertext(orgId: string, plaintext: string) {
  return (await createEncryptionService(LEGACY_KEY).encrypt(orgId, plaintext)).ciphertext;
}

describe("migrateNestedCustodySecrets", () => {
  it("re-encrypts a legacy fireblocks apiSecretEncrypted to v2 and preserves the rest", async () => {
    const cipher = v2Router();
    const innerCt = await legacyCiphertext("org1", "pem-secret");
    const config = JSON.stringify({
      provider: "fireblocks",
      apiKey: "key",
      apiSecretEncrypted: innerCt,
      vaultAccountId: "7",
      assetId: "SOL",
    });

    const result = await migrateNestedCustodySecrets(cipher, "org1", config);

    expect(result.changed).toBe(true);
    const parsed = JSON.parse(result.configJson);
    expect(parsed.apiSecretEncrypted.startsWith("v2.")).toBe(true);
    expect(await cipher.decrypt("org1", parsed.apiSecretEncrypted)).toBe("pem-secret");
    expect(parsed.apiKey).toBe("key");
    expect(parsed.vaultAccountId).toBe("7");
    expect(parsed.assetId).toBe("SOL");
  });

  it("re-encrypts a legacy local encryptedPrivateKey to v2", async () => {
    const cipher = v2Router();
    const innerCt = await legacyCiphertext("org1", "base58-key");
    const config = JSON.stringify({ provider: "local", encryptedPrivateKey: innerCt });

    const result = await migrateNestedCustodySecrets(cipher, "org1", config);

    expect(result.changed).toBe(true);
    const parsed = JSON.parse(result.configJson);
    expect(parsed.encryptedPrivateKey.startsWith("v2.")).toBe(true);
    expect(await cipher.decrypt("org1", parsed.encryptedPrivateKey)).toBe("base58-key");
  });

  it("leaves already-v2 nested values untouched", async () => {
    const cipher = v2Router();
    const innerCt = await cipher.encrypt("org1", "pem-secret");
    const config = JSON.stringify({
      provider: "fireblocks",
      apiKey: "key",
      apiSecretEncrypted: innerCt,
      vaultAccountId: "7",
      assetId: "SOL",
    });

    const result = await migrateNestedCustodySecrets(cipher, "org1", config);

    expect(result.changed).toBe(false);
    expect(result.configJson).toBe(config);
  });

  it("leaves configs without nested secrets untouched", async () => {
    const cipher = v2Router();
    const config = JSON.stringify({ provider: "privy", walletId: "w1" });

    const result = await migrateNestedCustodySecrets(cipher, "org1", config);

    expect(result.changed).toBe(false);
    expect(result.configJson).toBe(config);
  });

  it("rejects non-JSON payloads", async () => {
    const cipher = v2Router();

    await expect(migrateNestedCustodySecrets(cipher, "org1", "not-json")).rejects.toThrow(
      "not valid JSON"
    );
  });

  it("rejects non-object payloads", async () => {
    const cipher = v2Router();

    await expect(migrateNestedCustodySecrets(cipher, "org1", '["a"]')).rejects.toThrow(
      "not a JSON object"
    );
  });

  it("rejects v2 nested values that do not decrypt for the row's org", async () => {
    const cipher = v2Router();
    const innerCt = await cipher.encrypt("org2", "pem-secret");
    const config = JSON.stringify({
      provider: "fireblocks",
      apiKey: "key",
      apiSecretEncrypted: innerCt,
      vaultAccountId: "7",
      assetId: "SOL",
    });

    await expect(migrateNestedCustodySecrets(cipher, "org1", config)).rejects.toThrow();
  });

  it("propagates decryption failures for undecryptable nested values", async () => {
    const cipher = v2Router();
    const config = JSON.stringify({
      provider: "fireblocks",
      apiKey: "key",
      apiSecretEncrypted: "garbage-ciphertext",
      vaultAccountId: "7",
      assetId: "SOL",
    });

    await expect(migrateNestedCustodySecrets(cipher, "org1", config)).rejects.toThrow();
  });
});
