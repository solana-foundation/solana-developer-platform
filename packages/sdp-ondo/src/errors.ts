/**
 * Typed failures for the Ondo execution client, using the SHARED vault-direct
 * refusal vocabulary: `apps/sdp-api/src/services/earn/vault-refusals.ts`
 * matches `INVALID_AMOUNT` / `DEPOSIT_REFUSED` / `WITHDRAW_REFUSED` on the
 * `code` field so a caller-explainable refusal reaches the customer as a 400
 * carrying this class's own sentence, and anything else stays a 500 for SDP to
 * look at. Same shape as `SdpVedaError` / `SdpKaminoError`.
 */
export type SdpOndoErrorCode =
  | "INVALID_AMOUNT"
  | "DEPOSIT_REFUSED"
  | "WITHDRAW_REFUSED"
  | "UNSUPPORTED_VAULT"
  | "DEPLOYMENT_NOT_CONFIGURED"
  | "POSITION_UNREADABLE"
  | "SWAP_UNAVAILABLE";

export class SdpOndoError extends Error {
  constructor(
    public readonly code: SdpOndoErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SdpOndoError";
  }
}
