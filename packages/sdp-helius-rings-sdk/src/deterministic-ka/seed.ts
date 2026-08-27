/** Bytes the master seed must be. */
export const SEED_BYTE_LENGTH = 32;

/**
 * The seed every shielded identity is derived from. Hardcoded, so anyone with
 * this repository derives the same keys: devnet and testing only.
 */
export const DETERMINISTIC_KA_SEED: Uint8Array = new TextEncoder().encode(
  "INSECURE_TEST_SEED_DEVNET_ONLY!!"
);

let warned = false;

/** Warns once per process, not once per wallet. */
export function warnDeterministicKeyAuthority(): void {
  if (warned) return;
  warned = true;

  console.warn(
    "[helius-rings] INSECURE: shielded identities are derived from a hardcoded test seed. " +
      "Anyone with the source can derive the same keys and read or spend these notes. " +
      "Devnet and testing only."
  );
}
