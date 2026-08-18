import { type CustodyCipher, isV2Ciphertext } from "./cipher-router";

const NESTED_SECRET_FIELDS = ["apiSecretEncrypted", "encryptedPrivateKey"] as const;

export interface NestedSecretMigrationResult {
  changed: boolean;
  configJson: string;
}

export async function migrateNestedCustodySecrets(
  cipher: CustodyCipher,
  orgId: string,
  configJson: string
): Promise<NestedSecretMigrationResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    throw new Error("custody config is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("custody config is not a JSON object");
  }

  const config = parsed as Record<string, unknown>;
  let changed = false;

  for (const field of NESTED_SECRET_FIELDS) {
    const value = config[field];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }

    if (isV2Ciphertext(value)) {
      await cipher.decrypt(orgId, value);
      continue;
    }

    const plaintext = await cipher.decrypt(orgId, value);
    config[field] = await cipher.encrypt(orgId, plaintext);
    changed = true;
  }

  if (!changed) {
    return { changed: false, configJson };
  }

  return { changed: true, configJson: JSON.stringify(config) };
}
