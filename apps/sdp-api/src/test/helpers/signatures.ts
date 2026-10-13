import { getBase58Decoder } from "@solana/codecs";
import { type Signature, signature } from "@solana/kit";

/**
 * A synthetic, well-formed transaction signature: 64 bytes of `seed`, base58-encoded.
 *
 * @param seed - The byte every position of the signature holds; distinct seeds give distinct signatures.
 * @returns The signature.
 */
export function testSignature(seed: number): Signature {
  return signature(getBase58Decoder().decode(new Uint8Array(64).fill(seed)));
}
