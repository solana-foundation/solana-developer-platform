import type { EnvelopeKms } from "@/services/custody-cipher/envelope-cipher";

/** A 32-byte legacy custody master key, base64 encoded. */
export const TEST_LEGACY_CUSTODY_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * An in-memory KMS that wraps a data key reversibly and binds it to its AAD the
 * way Cloud KMS does: unwrapping under a different AAD fails.
 *
 * @returns The KMS a `KmsEnvelopeCipher` wraps its data keys with.
 */
export function fakeEnvelopeKms(): EnvelopeKms {
  const mask = (bytes: Uint8Array) => bytes.map((byte) => byte ^ 0x5a);
  return {
    encrypt: async (plaintext, aad) =>
      `${Buffer.from(aad).toString("base64")}!${Buffer.from(mask(plaintext)).toString("base64")}`,
    decrypt: async (ciphertext, aad) => {
      const [boundAad, wrapped] = ciphertext.split("!");
      if (boundAad !== Buffer.from(aad).toString("base64") || wrapped === undefined) {
        throw new Error("AAD mismatch");
      }
      return mask(new Uint8Array(Buffer.from(wrapped, "base64")));
    },
  };
}
