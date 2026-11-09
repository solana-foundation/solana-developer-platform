import { type CustodyCipher, createCipherRouter } from "@/services/custody-cipher/cipher-router";
import { EncryptionError } from "@/services/encryption.service";
import type { Env } from "@/types/env";

/** Separate keys from custody and SPC. Only upload references are encrypted. */
export function createEarnOnboardingCipher(
  env: Pick<
    Env,
    | "EARN_ONBOARDING_ENCRYPTION_KEY"
    | "EARN_ONBOARDING_KMS_KEY_NAME"
    | "CUSTODY_KMS_API_BASE_URL"
    | "CUSTODY_KMS_METADATA_TOKEN_URL"
  >
): CustodyCipher {
  const legacyKey = env.EARN_ONBOARDING_ENCRYPTION_KEY;
  const kmsKeyName = env.EARN_ONBOARDING_KMS_KEY_NAME;
  if (!legacyKey && !kmsKeyName)
    throw new EncryptionError("Earn onboarding encryption is not configured");
  return createCipherRouter(env, {
    legacyKey,
    kmsKeyName,
    legacyKeyEnvName: "EARN_ONBOARDING_ENCRYPTION_KEY",
  });
}
