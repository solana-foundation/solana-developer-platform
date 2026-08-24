/** Bytes the master seed must decode to. */
export const SEED_BYTE_LENGTH = 32;

/**
 * Decodes the master seed from the base64 form it is configured in.
 *
 * Every case here refuses to derive rather than warning. A short, malformed or
 * placeholder seed still yields usable-looking identities, and a wallet already
 * registered under one cannot be re-keyed, so the cost of accepting a bad seed
 * is paid much later and cannot be undone.
 *
 * This deliberately does not read `process.env`: the caller names the variable,
 * this function only decides what a valid seed is.
 */
export function decodeSeed(encoded: string | undefined): Uint8Array {
  if (encoded === undefined || encoded.length === 0) {
    throw new Error("The Rings derivation seed is required.");
  }

  const decoded = Buffer.from(encoded, "base64");
  // Buffer.from skips characters it cannot decode, so a round trip is what
  // separates real base64 from a truncated paste that happens to be 32 bytes.
  if (decoded.toString("base64") !== encoded) {
    throw new Error("The Rings derivation seed must be base64 with padding.");
  }
  if (decoded.length !== SEED_BYTE_LENGTH) {
    throw new Error(`The Rings derivation seed must decode to ${SEED_BYTE_LENGTH} bytes.`);
  }
  if (decoded.every((byte) => byte === 0)) {
    throw new Error("The Rings derivation seed must not be the all-zero placeholder.");
  }

  return new Uint8Array(decoded);
}
