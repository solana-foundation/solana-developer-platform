// Cipher for the SPC passwords SDP owns for project principals.
//
// Shares the custody cipher router — legacy AES-GCM, or Cloud KMS envelope
// encryption (`v2.` prefix) once SPC_CREDENTIAL_KMS_KEY_NAME is set — but under
// its OWN keys, deliberately:
//
//   * blast radius: compromising the custody key must not expose SPC
//     credentials, and vice versa;
//   * recoverability differs. Custody keys are irreplaceable — lose them and
//     wallet control is gone. An SPC password is re-issuable: identity
//     provisioning generates it and registers it with SPC, and the SDP actor
//     never sees it.
//
// Despite the router calling it `legacy`, SPC_CREDENTIAL_ENCRYPTION_KEY is required
// rather than optional: KMS auth goes through the GCE metadata server
// (lib/gcp/access-token.ts), so local dev, docker-compose, non-GCP self-hosting and
// CI all run on the v1 path. The KMS key is the GCP-only upgrade.
//
// Decryption dispatches on the ciphertext prefix, so the two schemes coexist in
// whichever environments end up using each.

import { type CustodyCipher, createCipherRouter } from "@/services/custody-cipher/cipher-router";
import { EncryptionError } from "@/services/encryption.service";
import type { Env } from "@/types/env";

/**
 * Every variable the SPC cipher reads. Callers must declare all of it: narrowing
 * to just the legacy key type-checks (every Env member is optional) but silently
 * writes v1 ciphertext in a KMS-configured deployment.
 */
export type SpcCredentialCipherEnv = Pick<
  Env,
  | "SPC_CREDENTIAL_ENCRYPTION_KEY"
  | "SPC_CREDENTIAL_KMS_KEY_NAME"
  | "CUSTODY_KMS_API_BASE_URL"
  | "CUSTODY_KMS_METADATA_TOKEN_URL"
>;

export function createSpcCredentialCipher(env: SpcCredentialCipherEnv): CustodyCipher {
  const legacyKey = env.SPC_CREDENTIAL_ENCRYPTION_KEY;
  const kmsKeyName = env.SPC_CREDENTIAL_KMS_KEY_NAME;
  // Fail fast rather than at the first encrypt/decrypt: neither key configured
  // means Private Channels identity provisioning cannot work at all.
  if (!legacyKey && !kmsKeyName) {
    throw new EncryptionError(
      "SPC_CREDENTIAL_ENCRYPTION_KEY environment variable is not configured"
    );
  }
  return createCipherRouter(env, {
    legacyKey,
    kmsKeyName,
    legacyKeyEnvName: "SPC_CREDENTIAL_ENCRYPTION_KEY",
  });
}
