/**
 * Coded errors thrown by the helius-rings domain. Operation-level failures
 * (policy denials, proof failures, etc.) do not throw — they land on the
 * operation row as a `FailureCode`. Errors here are for the API layer to map
 * to `AppError` at the sdp-api boundary.
 */
export type HeliusRingsErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "gateway_unavailable"
  | "config_error"
  | "insufficient_balance"
  | "manual_reconciliation_required";

export class HeliusRingsError extends Error {
  readonly code: HeliusRingsErrorCode;

  constructor(code: HeliusRingsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HeliusRingsError";
    this.code = code;
  }
}
