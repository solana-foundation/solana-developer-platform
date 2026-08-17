import type { SolanaCluster } from "@sdp/types";
import type { Address } from "@solana/kit";

/**
 * Errors this package raises, mirroring `@sdp/earn/errors` in shape: a `code`
 * the API can map to a status, and a message that says what was actually wrong.
 * Deliberately NOT re-using `@sdp/earn`'s constructors — that would put an
 * `@sdp/kamino → @sdp/earn` edge in place for three error shapes.
 */
export type SdpKaminoErrorCode = "INVALID_AMOUNT" | "VAULT_UNREADABLE" | "PROGRAM_MISMATCH";

export class SdpKaminoError extends Error {
  constructor(
    readonly code: SdpKaminoErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SdpKaminoError";
  }
}

/**
 * A caller-supplied amount that is not a decimal string, is negative, or is
 * zero. Raised BEFORE any RPC call — an unparseable amount is a programming
 * error on the caller's side and must never reach the chain.
 */
export function invalidAmount(field: string, value: string): SdpKaminoError {
  return new SdpKaminoError(
    "INVALID_AMOUNT",
    `Kamino ${field} must be a positive decimal string; received ${JSON.stringify(value)}`
  );
}

/**
 * A caller-supplied amount that is finer than the mint can represent.
 *
 * Distinct from `invalidAmount` because the value IS a well-formed decimal — it
 * simply carries more places than the mint has atoms, and klend-sdk FLOORS
 * rather than rejects. Two different failures hide behind that floor: a deposit
 * records more than it encodes (`1.0000009` on a 6-decimal mint moves
 * `1.000000`), and a positive `minSharesOut` below one atom becomes `0`, which
 * silently removes the very protection it was passed to provide. Refusing is
 * the only answer that keeps the recorded number and the encoded number equal.
 */
export function amountTooPrecise(field: string, value: string, decimals: number): SdpKaminoError {
  return new SdpKaminoError(
    "INVALID_AMOUNT",
    `Kamino ${field} ${JSON.stringify(value)} has more precision than its mint supports ` +
      `(${decimals} decimals). The SDK would floor it, so the amount encoded on chain would not ` +
      "match the amount requested."
  );
}

/** A decimal whose mint-scaled integer cannot fit Kamino's on-chain u64 field. */
export function amountOutOfRange(field: string, value: string): SdpKaminoError {
  return new SdpKaminoError(
    "INVALID_AMOUNT",
    `Kamino ${field} ${JSON.stringify(value)} exceeds the maximum unsigned 64-bit base-unit amount`
  );
}

/**
 * The vault account could not be read on this cluster.
 *
 * The most likely cause is the RPC pointing at the wrong chain: Kamino's mainnet
 * kvault program id ALSO exists on devnet with zero accounts under it, so a
 * cluster/RPC mismatch presents as "this vault does not exist" rather than as a
 * connection error. The message names both so the reader checks the right thing.
 */
export function vaultUnreadable(
  vault: Address,
  cluster: SolanaCluster,
  cause: unknown
): SdpKaminoError {
  return new SdpKaminoError(
    "VAULT_UNREADABLE",
    `Kamino vault ${vault} could not be read on ${cluster}. ` +
      "Check that the RPC endpoint serves that cluster — a mismatched RPC reports a missing vault, not a connection error.",
    { cause }
  );
}
