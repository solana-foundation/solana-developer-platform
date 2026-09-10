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
// alongside KMS so a deployment can never start unable to read an existing v1
// row. KMS auth goes through the GCE metadata server (lib/gcp/access-token.ts),
// so local dev, docker-compose, non-GCP self-hosting and CI leave the KMS name
// unset and run on the v1 path.
//
// Decryption dispatches on the ciphertext prefix, so the two schemes coexist in
// whichever environments end up using each.

import { HeliusRingsError } from "@sdp/helius-rings";
import { type CustodyCipher, createCipherRouter } from "@/services/custody-cipher/cipher-router";
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

const KMS_KEY_NAME = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;

function legacyKeyByteLength(value: string): number {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  try {
    return atob(`${normalized}${padding}`).length;
  } catch (error) {
    throw new HeliusRingsError("config_error", "RINGS_KEY_ENCRYPTION_KEY must be valid base64", {
      cause: error,
    });
  }
}

export function createRingsKeyCipher(env: RingsKeyCipherEnv): CustodyCipher {
  const legacyKey = env.RINGS_KEY_ENCRYPTION_KEY;
  const kmsKeyName = env.RINGS_KEY_KMS_KEY_NAME?.trim() || undefined;
  // Fail fast rather than at the first encrypt/decrypt: neither key configured
  // means the database key authority cannot provision or read a wallet at all.
  if (!legacyKey && !kmsKeyName) {
    throw new HeliusRingsError(
      "config_error",
      "Rings key encryption is not configured; set RINGS_KEY_ENCRYPTION_KEY and optionally RINGS_KEY_KMS_KEY_NAME"
    );
  }
  if (legacyKey && legacyKeyByteLength(legacyKey) !== 32) {
    throw new HeliusRingsError(
      "config_error",
      "RINGS_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes"
    );
  }
  if (kmsKeyName && !KMS_KEY_NAME.test(kmsKeyName)) {
    throw new HeliusRingsError(
      "config_error",
      "RINGS_KEY_KMS_KEY_NAME must be a full Cloud KMS key name"
    );
  }
  if (kmsKeyName && !legacyKey) {
    throw new HeliusRingsError(
      "config_error",
      "RINGS_KEY_ENCRYPTION_KEY must remain configured with KMS so legacy v1 rows stay readable"
    );
  }
  const cipher = createCipherRouter(env, {
    legacyKey,
    kmsKeyName,
    legacyKeyEnvName: "RINGS_KEY_ENCRYPTION_KEY",
  });

  const asConfigError = (error: unknown): HeliusRingsError =>
    error instanceof HeliusRingsError
      ? error
      : new HeliusRingsError(
          "config_error",
          "Rings key encryption is unavailable; verify its key, KMS configuration, and access",
          { cause: error }
        );

  return {
    async encrypt(orgId, plaintext) {
      try {
        return await cipher.encrypt(orgId, plaintext);
      } catch (error) {
        throw asConfigError(error);
      }
    },
    async decrypt(orgId, ciphertext) {
      try {
        return await cipher.decrypt(orgId, ciphertext);
      } catch (error) {
        throw asConfigError(error);
      }
    },
  };
}
