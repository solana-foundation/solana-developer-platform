// Cipher for the Helius Rings shielded key material SDP holds at rest.
//
// Shares the custody cipher router — legacy AES-GCM, or Cloud KMS envelope
// encryption (`v2.` prefix) once RINGS_KEY_KMS_KEY_NAME is set — but under its
// OWN keys, deliberately:
//
//   * blast radius: compromising the custody key must not expose shielded
//     material, and vice versa;
//   * these are the least recoverable secrets in the system. A custody key at
//     least has an external provider path; a nullifier key does not. Lose it and
//     every note encrypted to that identity is unspendable, with nothing on
//     chain that can re-open it. Even the SPC comparison does not hold: an SPC
//     password is re-issuable, a shielded key is not.
//
// Despite the router calling it `legacy`, RINGS_KEY_ENCRYPTION_KEY is required
// rather than optional: KMS auth goes through the GCE metadata server
// (lib/gcp/access-token.ts), so local dev, docker-compose, non-GCP self-hosting
// and CI all run on the v1 path. The KMS key is the GCP-only upgrade.
//
// Decryption dispatches on the ciphertext prefix, so the two schemes coexist in
// whichever environments end up using each.

import { type CustodyCipher, createCipherRouter } from "@/services/custody-cipher/cipher-router";
import { EncryptionError } from "@/services/encryption.service";
import type { Env } from "@/types/env";

/**
 * Every variable the Rings key cipher reads. Callers must declare all of it:
 * narrowing to just the legacy key type-checks (every Env member is optional)
 * but silently writes v1 ciphertext in a KMS-configured deployment.
 */
export type RingsKeyCipherEnv = Pick<
  Env,
  | "RINGS_KEY_ENCRYPTION_KEY"
  | "RINGS_KEY_KMS_KEY_NAME"
  | "CUSTODY_KMS_API_BASE_URL"
  | "CUSTODY_KMS_METADATA_TOKEN_URL"
>;

export function createRingsKeyCipher(env: RingsKeyCipherEnv): CustodyCipher {
  const legacyKey = env.RINGS_KEY_ENCRYPTION_KEY;
  const kmsKeyName = env.RINGS_KEY_KMS_KEY_NAME;
  // Fail fast rather than at the first encrypt/decrypt: neither key configured
  // means the database key authority cannot provision or read a wallet at all.
  if (!legacyKey && !kmsKeyName) {
    throw new EncryptionError("RINGS_KEY_ENCRYPTION_KEY environment variable is not configured");
  }
  return createCipherRouter(env, {
    legacyKey,
    kmsKeyName,
    legacyKeyEnvName: "RINGS_KEY_ENCRYPTION_KEY",
  });
}
