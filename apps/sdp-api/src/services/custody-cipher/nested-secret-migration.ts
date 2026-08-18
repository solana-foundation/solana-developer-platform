import { type CustodyCipher, isV2Ciphertext } from "./cipher-router";

/**
 * Provider config fields that hold ciphertext of their own, encrypted with the
 * same custody cipher as the enclosing config: fireblocks stores its API
 * secret PEM, local stores the raw signing key. Re-wrapping the outer config
 * does not touch these, so retiring the legacy key requires migrating them
 * explicitly.
 */
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
    return { changed: false, configJson };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { changed: false, configJson };
  }

  const config = parsed as Record<string, unknown>;
  let changed = false;

  for (const field of NESTED_SECRET_FIELDS) {
    const value = config[field];
    if (typeof value !== "string" || value.length === 0 || isV2Ciphertext(value)) {
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
