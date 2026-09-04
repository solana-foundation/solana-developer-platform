export type SdpJupiterLendErrorCode =
  | "INVALID_AMOUNT"
  | "MARKET_UNREADABLE"
  | "CLUSTER_UNSUPPORTED"
  | "PROGRAM_MISMATCH";

export class SdpJupiterLendError extends Error {
  constructor(
    readonly code: SdpJupiterLendErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SdpJupiterLendError";
  }
}
