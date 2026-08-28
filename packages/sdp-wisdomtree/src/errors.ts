/**
 * Error taxonomy for `@sdp/wisdomtree` — the package's own class, per the
 * provider-package convention (`SdpKaminoError` precedent): the API layer maps
 * codes it recognizes onto HTTP answers and rethrows the rest.
 */
export type SdpWisdomTreeErrorCode =
  /** The providerReference names no fund in the measured registry. */
  | "FUND_UNKNOWN"
  /** The fund's instrument does not exist on the requested cluster. */
  | "CLUSTER_UNSUPPORTED"
  /** Caller-fault amount problems: unparsable, zero, or sub-atomic precision. */
  | "INVALID_AMOUNT"
  /** A chain read failed or returned an account this package refuses to trust. */
  | "CHAIN_UNREADABLE"
  /**
   * The live mint does not match the measured registry (wrong owner program,
   * decimals, or transfer-hook program). Refusing is the point: building
   * against a drifted instrument moves money under stale assumptions.
   */
  | "MINT_MISMATCH";

export class SdpWisdomTreeError extends Error {
  constructor(
    public readonly code: SdpWisdomTreeErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SdpWisdomTreeError";
  }
}
