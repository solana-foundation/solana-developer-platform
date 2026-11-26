import { describe, expect, it } from "vitest";
import { createEncryptionService } from "@/services/encryption.service";
import { fakeEnvelopeKms, TEST_LEGACY_CUSTODY_KEY } from "@/test/helpers/custody-cipher";
import { CustodyCipherRouter } from "./cipher-router";
import { KmsEnvelopeCipher } from "./envelope-cipher";
import { migrateNestedCustodySecrets } from "./nested-secret-migration";

function v2Router() {
  return new CustodyCipherRouter({
    legacyKey: TEST_LEGACY_CUSTODY_KEY,
    envelope: new KmsEnvelopeCipher({ kms: fakeEnvelopeKms() }),
    activeScheme: "v2",
  });
}

async function legacyCiphertext(orgId: string, plaintext: string) {
  return (await createEncryptionService(TEST_LEGACY_CUSTODY_KEY).encrypt(orgId, plaintext))
    .ciphertext;
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

    await expect(migrateNestedCustodySecrets(cipher, "org1", config)).rejects.toThrow(
      "AAD mismatch"
    );
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
