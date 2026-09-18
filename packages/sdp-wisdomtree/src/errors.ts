/**
 * Error taxonomy for `@sdp/wisdomtree` — the package's own class, per the
 * provider-package convention (`SdpKaminoError` precedent): the API layer maps
 * codes it recognizes onto HTTP answers and rethrows the rest. The mapped
 * vocabulary is shared with every vault-direct provider — see the API's
 * `rethrowVaultProviderFailure`: `INVALID_AMOUNT`, `DEPOSIT_REFUSED` and
 * `WITHDRAW_REFUSED` are caller-fixable 400s, `VAULT_UNREADABLE` is a
 * retryable 503, and everything else keeps bubbling as an internal fault.
 */
export type SdpWisdomTreeErrorCode =
  /** The fund's instrument does not exist on the requested cluster. */
  | "CLUSTER_UNSUPPORTED"
  /** Caller-fault amount problems: unparsable, zero, or sub-atomic precision. */
  | "INVALID_AMOUNT"
  /**
   * The subscription refuses: the fund is paused (settlement disabled), so the
   * USDC leg could land without WisdomTree ever delivering shares.
   */
  | "DEPOSIT_REFUSED"
  /**
   * The redemption refuses: the fund is paused, or the compliance hook does
   * not recognize a wallet — hook resolution failing IS the KYC gate answering
   * no. The hook only ever gates builds of fund-token transfers, which SDP
   * builds for redemptions alone.
   */
  | "WITHDRAW_REFUSED"
  /** A chain read failed or returned an account this package refuses to trust. */
  | "VAULT_UNREADABLE"
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
