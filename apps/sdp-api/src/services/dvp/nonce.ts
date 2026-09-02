/**
 * Nonce generation for DvP trades.
 *
 * `CreateDvp` is permissionless and the nonce is one of the SwapDvp PDA seeds, so
 * a predictable nonce lets a third party squat the address the real parties were
 * about to use. Once they reject the squatted trade its nonce tombstone burns
 * that value forever, so they need a fresh one anyway. The program's own guidance
 * is a cryptographically random 64-bit value per trade, which is what this is.
 *
 * Returns a `bigint`, never a `number`: the value is a PDA seed, and anything
 * above 2^53 rounds when it passes through a JS number, deriving a different
 * address than the one a counterparty was told to fund. `@sdp/dvp`'s codecs
 * reject a `number` at runtime for the same reason.
 */

import { randomBytes } from "node:crypto";

/** Largest value a u64 seed can carry. */
export const MAX_U64 = 2n ** 64n - 1n;

/** A cryptographically random u64, as a bigint. */
export function randomDvpNonce(): bigint {
  // Big-endian assembly of 8 random bytes. Every bit is random, so the value is
  // uniform across the whole u64 range rather than clustered in the low bits the
  // way a Math.random()-derived integer would be.
  let nonce = 0n;
  for (const byte of randomBytes(8)) {
    nonce = (nonce << 8n) | BigInt(byte);
  }
  return nonce;
}
