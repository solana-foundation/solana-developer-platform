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
