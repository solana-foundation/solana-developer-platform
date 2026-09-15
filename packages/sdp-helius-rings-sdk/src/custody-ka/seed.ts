import type { Bytes32 } from "@heliuslabs/zolana";
import { ED25519_SEED_LEN, ed25519DerivationMessage } from "@heliuslabs/zolana/keypair";
import { address, getAddressEncoder, getBase64Codec } from "@solana/kit";

/**
 * The derivation seed for one owner: its Ed25519 signature over Zolana's
 * derivation message.
 *
 * Ed25519 signing is deterministic (RFC 8032), so the same custody key over the
 * same message yields the same 64 bytes forever. That is what makes a signature
 * usable as a key root rather than merely as an authorization.
 */

/** Signs raw bytes with the custody key for `owner`; base64 in, base64 out. */
export type SignMessage = (messageBase64: string, owner: string) => Promise<string>;

/**
 * The exact bytes a custody signer must sign: Zolana's 99-byte Solana
 * off-chain-message v0 envelope, not the bare `"TSPP/derive/v1"` payload a
 * browser wallet signs. The two produce different seeds and therefore different
 * shielded identities, with no reconciliation between them.
 */
export function derivationMessageBase64(owner: string): string {
  const ownerBytes = new Uint8Array(getAddressEncoder().encode(address(owner))) as Bytes32;
  return getBase64Codec().decode(ed25519DerivationMessage(ownerBytes));
}

/**
 * Fetches one owner's seed through custody.
 *
 * The width check is here rather than left to Zolana so a provider returning
 * something short fails naming custody, which is where the fault is. Zolana
 * verifies the signature itself on every key build, so this does not repeat it.
 */
export async function fetchDerivationSeed(
  signMessage: SignMessage,
  owner: string
): Promise<Uint8Array> {
  const signatureBase64 = await signMessage(derivationMessageBase64(owner), owner);
  const seed = new Uint8Array(getBase64Codec().encode(signatureBase64));

  if (seed.length !== ED25519_SEED_LEN) {
    throw new Error(
      `Custody returned a ${seed.length}-byte signature for ${owner}; a Rings derivation seed must be ${ED25519_SEED_LEN} bytes.`
    );
  }

  return seed;
}
