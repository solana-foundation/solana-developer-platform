/**
 * Guarded u64/i64 encoders for the generated instruction and account codecs.
 *
 * Same guard `@sdp/dvp` carries (`packages/sdp-dvp/src/safeNumberCodecs.ts`).
 * `@solana/kit`'s `getU64Encoder` / `getI64Encoder` accept `number | bigint`
 * and encode via `BigInt(value)`. A JavaScript `number` above
 * `Number.MAX_SAFE_INTEGER` has already lost precision by then, so distinct
 * 64-bit values collapse to the same wire bytes with no error. For the escrow
 * program that is silent value corruption: a deposit, release, or withdrawal
 * would move an amount different from the one the caller recorded, and
 * `transactionNonce` is a PDA seed, so a rounded value derives a different
 * address than the one the counterparty funds.
 *
 * These wrappers require a `bigint` and throw on any `number`. The codegen
 * patch (`scripts/patch-safe-numbers.ts`) rewrites the generated encoders to
 * use them; keep this file outside `generated/` so it survives regeneration.
 */

import { type FixedSizeEncoder, getI64Encoder, getU64Encoder, transformEncoder } from "@solana/kit";

function requireBigint(codec: string, value: bigint): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(
      `${codec} argument must be a bigint, got ${typeof value}. ` +
        `A JavaScript number cannot represent all 64-bit values (anything ` +
        `above 2^53 rounds), so pass a bigint literal such as 123n for ` +
        `token amounts and nonces.`
    );
  }
  return value;
}

/**
 * `getU64Encoder` that rejects `number`, requiring a lossless `bigint`.
 * Stays fixed-size (8 bytes) so all-fixed instruction structs keep their
 * `FixedSizeEncoder` type.
 */
export function getSafeU64Encoder(): FixedSizeEncoder<bigint> {
  return transformEncoder(getU64Encoder(), (value: bigint) => requireBigint("u64", value));
}

/** `getI64Encoder` that rejects `number`, requiring a lossless `bigint`. */
export function getSafeI64Encoder(): FixedSizeEncoder<bigint> {
  return transformEncoder(getI64Encoder(), (value: bigint) => requireBigint("i64", value));
}
