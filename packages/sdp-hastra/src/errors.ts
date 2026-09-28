/** Stable execution failures understood by the Earn vault refusal adapter. */
export type SdpHastraErrorCode =
  | "INVALID_AMOUNT"
  | "DEPOSIT_REFUSED"
  | "WITHDRAW_REFUSED"
  | "REDEMPTION_REFUSED"
  | "UNSUPPORTED_VAULT"
  | "DEPLOYMENT_NOT_CONFIGURED"
  | "POSITION_UNREADABLE"
  | "REQUEST_UNREADABLE"
  | "PROGRAM_MISMATCH"
  | "SWAP_UNAVAILABLE";

export class SdpHastraError extends Error {
  constructor(
    public readonly code: SdpHastraErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SdpHastraError";
  }
}
